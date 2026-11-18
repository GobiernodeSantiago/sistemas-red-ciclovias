"""
Servidor local del visor con edición de capas.

Uso:  python servidor.py          (lo ejecuta abrir_visor.bat)
Abre  http://localhost:8765/index.html

Además de servir los archivos del visor, permite editar desde el navegador la capa de
sistemas y la de ciclovías existentes:
  GET  /api/estado            -> {"edicion": true}  (el visor muestra las herramientas sólo si responde)
  GET  /api/capa/<id>         -> capa original completa (todos los campos) en WGS84
  POST /api/capa/<id>         -> guarda los cambios en el GeoJSON de entrada (con respaldo en
                                 <carpeta de capas>/respaldos) y vuelve a ejecutar procesar_red.py
<id> = "sistemas" o "existentes". Las rutas se leen de la CONFIGURACIÓN de procesar_red.py.

Sólo escucha en 127.0.0.1 (este computador). En GitHub Pages no existe /api, así que la
versión publicada no muestra la edición.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
sys.path.insert(0, str(RAIZ / "procesamiento"))
import procesar_red as pr  # noqa: E402  (rutas de entrada y nombres de campos)

import geopandas as gpd  # noqa: E402
import pandas as pd  # noqa: E402
from shapely.geometry import MultiLineString, shape  # noqa: E402

PUERTO = 8765
SCRIPT = RAIZ / "procesamiento" / "procesar_red.py"

# Capas editables. "largo": campo que se recalcula (en km) cuando cambia la geometría de un tramo.
# El KM de las existentes viene del catastro (no coincide con la geometría), por eso sólo se
# completa en tramos nuevos.
CAPAS = {
    "sistemas": {"archivo": pr.SISTEMAS, "nombre": "Sistemas",
                 "obligatorios": [pr.CAMPO_SISTEMA, pr.CAMPO_TIPO], "largo": "km", "largo_al_editar": True},
    "existentes": {"archivo": pr.EXISTENTES, "nombre": "Ciclovías existentes",
                   "obligatorios": [], "largo": "KM", "largo_al_editar": False},
}
CANDADO = threading.Lock()   # un guardado a la vez


def leer(capa):
    return gpd.read_file(CAPAS[capa]["archivo"])


def capa_para_editar(capa):
    """Capa completa en WGS84 + descripción de los campos (tipo y valores frecuentes para sugerir)."""
    c = CAPAS[capa]
    g = leer(capa)
    campos = []
    for col in g.columns:
        if col == "geometry":
            continue
        numero = pd.api.types.is_numeric_dtype(g[col])
        valores = []
        if not numero:
            vc = g[col].dropna().astype(str)
            vc = vc[vc.str.strip() != ""].value_counts()
            if len(vc) <= 60:
                valores = vc.index.tolist()
        campos.append({"nombre": col, "tipo": "numero" if numero else "texto", "valores": valores,
                       "obligatorio": col in c["obligatorios"], "largo": col == c["largo"]})
    w = g.to_crs(4326)
    w["_fid"] = range(len(w))
    fc = json.loads(w.to_json(na="null", drop_id=True))
    return {"capa": capa, "nombre": c["nombre"], "archivo": str(c["archivo"]), "campos": campos, "geojson": fc}


def a_valor(serie, v):
    """Convierte el valor del formulario al tipo de la columna."""
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    if pd.api.types.is_numeric_dtype(serie):
        n = pd.to_numeric(str(v).replace(",", "."), errors="coerce")
        if pd.isna(n):
            raise ValueError(f"'{v}' no es un número válido para el campo {serie.name}")
        return float(n)
    return str(v)


def a_geometria(gj, crs, con_z=False):
    """GeoJSON (WGS84) -> MultiLineString en el sistema de coordenadas de la capa.
    Si la capa tiene Z, los vértices conservan su Z y los nuevos o movidos (que llegan sin Z) quedan con 0."""
    def norm(c):
        if c and isinstance(c[0], (int, float)):
            return [c[0], c[1], c[2] if len(c) > 2 else 0.0] if con_z else [c[0], c[1]]
        return [norm(x) for x in c]
    geom = shape({"type": gj["type"], "coordinates": norm(gj["coordinates"])})
    if geom.is_empty or geom.geom_type not in ("LineString", "MultiLineString"):
        raise ValueError("cada tramo debe ser una línea")
    geom = gpd.GeoSeries([geom], crs=4326).to_crs(crs).iloc[0]
    if geom.geom_type == "LineString":
        geom = MultiLineString([geom])
    if geom.length < 0.5:
        raise ValueError("hay un tramo de largo casi cero (menos de 0,5 m)")
    return geom


def aplicar_cambios(capa, cambios, archivo=None):
    """Aplica {borrados, modificados, nuevos} al GeoJSON de la capa. Devuelve un resumen.
    Sólo se reescriben las geometrías que cambiaron: los demás tramos conservan sus coordenadas originales."""
    c = CAPAS[capa]
    archivo = Path(archivo or c["archivo"])
    g = gpd.read_file(archivo)
    crs = g.crs
    con_z = bool(g.has_z.any())
    n = len(g)
    largo = c["largo"] if c["largo"] in g.columns else None

    def fid(x):
        i = int(x)
        if not 0 <= i < n:
            raise ValueError(f"tramo {x} no existe en la capa (¿se modificó el archivo mientras editabas?)")
        return i

    borrados = {fid(x) for x in cambios.get("borrados", [])}
    for m in cambios.get("modificados", []):
        i = fid(m["_fid"])
        if i in borrados:
            continue
        for k, v in (m.get("atributos") or {}).items():
            if k in g.columns and k != "geometry":
                g.at[i, k] = a_valor(g[k], v)
        if m.get("geometria"):
            g.at[i, "geometry"] = a_geometria(m["geometria"], crs, con_z)
            # largo: se recalcula si la capa lo pide, o si viene vacío (p. ej. un tramo cortado en dos)
            if largo and (c["largo_al_editar"] or pd.isna(g.at[i, largo])):
                g.at[i, largo] = round(g.at[i, "geometry"].length / 1000, 3)

    filas = []
    for nv in cambios.get("nuevos", []):
        geom = a_geometria(nv["geometria"], crs, con_z)
        fila = {k: a_valor(g[k], v) for k, v in (nv.get("atributos") or {}).items() if k in g.columns and k != "geometry"}
        if largo and fila.get(largo) is None:
            fila[largo] = round(geom.length / 1000, 3)
        fila["geometry"] = geom
        filas.append(fila)

    g = g.drop(index=sorted(borrados))
    if filas:
        g = pd.concat([g, gpd.GeoDataFrame(filas, geometry="geometry", crs=crs)], ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs=crs).reset_index(drop=True)

    for col in c["obligatorios"]:
        vacios = g[col].isna() | (g[col].astype(str).str.strip() == "")
        if vacios.any():
            raise ValueError(f"{int(vacios.sum())} tramo(s) sin valor en el campo obligatorio «{col}»")

    # respaldo del archivo original y escritura segura (archivo temporal + reemplazo)
    resp_dir = archivo.parent / "respaldos"
    resp_dir.mkdir(exist_ok=True)
    respaldo = resp_dir / f"{archivo.stem}_{datetime.now():%Y%m%d_%H%M%S}{archivo.suffix}"
    shutil.copy2(archivo, respaldo)
    tmp = archivo.with_name(archivo.stem + "_guardando" + archivo.suffix)
    if tmp.exists():
        tmp.unlink()
    g.to_file(tmp, driver="GeoJSON")
    os.replace(tmp, archivo)
    return {"tramos_antes": n, "tramos_despues": len(g), "borrados": len(borrados),
            "modificados": len(cambios.get("modificados", [])), "nuevos": len(filas), "respaldo": str(respaldo)}


def recalcular():
    """Vuelve a ejecutar el análisis de red (genera data/datos.js y data/capas.js)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, str(SCRIPT)], cwd=RAIZ, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=1800, env=env)
    return r.returncode == 0, (r.stdout + r.stderr)[-6000:]


class Manejador(SimpleHTTPRequestHandler):
    def _json(self, codigo, obj):
        cuerpo = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def _api(self):
        # cabecera propia: un sitio externo no puede enviarla sin permiso CORS (que este servidor no da)
        if self.headers.get("X-Visor") != "1":
            self._json(403, {"error": "solicitud no permitida"})
            return None
        partes = self.path.split("?")[0].strip("/").split("/")
        return partes[1:]   # sin "api"

    def do_GET(self):
        if not self.path.startswith("/api/"):
            return super().do_GET()
        p = self._api()
        if p is None:
            return
        if p == ["estado"]:
            return self._json(200, {"edicion": True, "capas": {k: v["nombre"] for k, v in CAPAS.items()}})
        if len(p) == 2 and p[0] == "capa" and p[1] in CAPAS:
            try:
                return self._json(200, capa_para_editar(p[1]))
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": f"no se pudo leer la capa: {e}"})
        self._json(404, {"error": "no existe"})

    def do_POST(self):
        p = self._api()
        if p is None:
            return
        if not (len(p) == 2 and p[0] == "capa" and p[1] in CAPAS):
            return self._json(404, {"error": "no existe"})
        try:
            largo = int(self.headers.get("Content-Length", 0))
            cambios = json.loads(self.rfile.read(largo).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return self._json(400, {"error": "datos inválidos"})
        if not CANDADO.acquire(blocking=False):
            return self._json(409, {"error": "ya hay un guardado en curso"})
        try:
            try:
                resumen = aplicar_cambios(p[1], cambios)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            print(f"Guardado {p[1]}: {resumen}")
            print("Recalculando análisis de red...")
            ok, log = recalcular()
            print("Análisis listo." if ok else "ERROR en el análisis:\n" + log)
            self._json(200, {"ok": ok, "resumen": resumen, "log": log})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"error al guardar: {e}"})
        finally:
            CANDADO.release()

    def end_headers(self):
        if self.path.split("?")[0].endswith((".html", ".js")):
            self.send_header("Cache-Control", "no-cache")   # siempre la versión recién generada
        super().end_headers()

    def log_message(self, fmt, *args):
        codigo = str(args[1]) if len(args) > 1 else "5"   # sólo se muestran la API y los errores
        if "/api/" in getattr(self, "path", "") or codigo[:1] in ("4", "5"):
            super().log_message(fmt, *args)


class Servidor(ThreadingHTTPServer):
    # sin reutilizar el puerto: en Windows, con reutilización, dos visores abiertos comparten el puerto sin aviso
    allow_reuse_address = False
    allow_reuse_port = False


if __name__ == "__main__":
    if "--puerto" in sys.argv:
        PUERTO = int(sys.argv[sys.argv.index("--puerto") + 1])
    try:
        srv = Servidor(("127.0.0.1", PUERTO), partial(Manejador, directory=str(RAIZ)))
    except OSError:
        print(f"\nEl puerto {PUERTO} ya está en uso: probablemente hay otra ventana del visor abierta.")
        print("Ciérrala (la otra ventana negra) y vuelve a abrir abrir_visor.bat.")
        sys.exit(1)
    url = f"http://localhost:{PUERTO}/index.html"
    print(f"Visor de red de ciclovías en {url}")
    if "--sin-navegador" not in sys.argv:
        import webbrowser
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    print("Edición de capas habilitada (sólo en este computador).")
    print("Cierra esta ventana para detener el visor.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

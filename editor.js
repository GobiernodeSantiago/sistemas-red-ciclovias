// Edición de capas tipo SIG: sistemas y ciclovías existentes.
// Sólo aparece al abrir el visor con abrir_visor.bat (servidor.py); en GitHub Pages no existe /api y no se muestra.
// Guardar escribe el GeoJSON de entrada (con respaldo) y vuelve a ejecutar el análisis de red.
// Usa del visor: map, D, vis, medir, setModoMedir, modoSV, setModoSV.
(() => {
  const H = { "X-Visor": "1" };
  const DRAW_JS = "https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.js";
  const COLOR = { sistemas: "#7b3fbf", existentes: "#2a78d6" };
  const OCULTAR = { sistemas: ["sis-sel", "sis-alt", "sis-pto", "sis-casing", "sis-otros"],
                    existentes: ["ex-base", "ex-act", "ex-act-casing"] };
  const SNAP_PX = 12;      // distancia (pantalla) para ajustar a vértices y bordes
  const MAX_DESHACER = 40;

  const ed = { capa: null, nombre: "", draw: null, campos: [], originales: new Set(), geom: new Set(), attrs: new Map(),
               pila: [], ultimo: null, visPrev: {}, snap: true, snapCache: null, sel: null, guardando: false };
  window.EDICION = ed;   // mientras ed.capa != null, el clic normal del visor (popups) no actúa

  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const $ = id => document.getElementById(id);

  // ---------- estilos del panel
  const css = document.createElement("style");
  css.textContent = `
  .ctl-ed { width: 29px; height: 29px; display: grid; place-items: center; cursor: pointer; }
  .ctl-ed[aria-pressed="true"] { background: #efe6fa !important; }
  .ed-panel { width: 300px; max-height: calc(100vh - 150px); overflow-y: auto; background: var(--surface);
    border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.18); padding: 10px 12px; font-size: 12px; color: var(--ink-2); }
  .ed-panel[hidden] { display: none; }
  .ed-panel h3 { margin: 0 0 6px; font-size: 13px; color: var(--ink); display: flex; align-items: center; gap: 6px; }
  .ed-panel h3 small { margin-left: auto; font-weight: 400; color: var(--muted); }
  .ed-capas { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
  .ed-panel button { border: 1px solid var(--line); background: #fff; border-radius: 6px; cursor: pointer; font: inherit;
    font-size: 12px; padding: 5px 8px; color: var(--ink); }
  .ed-panel button:hover:not(:disabled) { background: #f0efec; }
  .ed-panel button:disabled { opacity: .45; cursor: default; }
  .ed-panel button[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }
  .ed-panel button.prim { background: var(--accent); color: #fff; border-color: var(--accent); }
  .ed-panel button.prim:hover:not(:disabled) { background: #1f63b5; }
  .ed-barra { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 6px 0; }
  .ed-barra button { padding: 5px 4px; font-size: 11.5px; }
  .ed-ayuda { line-height: 1.4; margin: 4px 0 8px; color: var(--ink-2); }
  .ed-chk { display: flex; align-items: center; gap: 6px; margin: 2px 0 8px; cursor: pointer; }
  .ed-sec { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 4px; }
  .ed-ftit { font-weight: 600; color: var(--ink); margin-bottom: 4px; }
  .ed-campo { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 6px; margin: 3px 0; }
  .ed-campo span { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-campo input { font: inherit; font-size: 12px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px;
    min-width: 0; color: var(--ink); background: #fff; }
  .ed-campo input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .ed-campo input.mal { border-color: #d03b3b; background: #fdf0f0; }
  .ed-pie { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; margin-top: 8px; }
  .ed-pie span { flex: 1; line-height: 1.3; }
  .ed-msg { margin-top: 6px; line-height: 1.4; }
  .ed-msg:empty { display: none; }
  .ed-msg.err { color: #b4462a; }
  .ed-msg pre { white-space: pre-wrap; font-size: 10.5px; max-height: 160px; overflow: auto; background: #f4f3f0;
    padding: 6px; border-radius: 4px; color: var(--ink-2); }
  .maplibregl-ctrl-group:empty { display: none; }
  .maplibregl-map.mode-draw_line_string .maplibregl-canvas-container.maplibregl-interactive,
  .maplibregl-map.mouse-add .maplibregl-canvas-container.maplibregl-interactive { cursor: crosshair; }
  .maplibregl-map.mouse-pointer .maplibregl-canvas-container.maplibregl-interactive { cursor: pointer; }
  .maplibregl-map.mouse-move .maplibregl-canvas-container.maplibregl-interactive { cursor: move; }`;
  document.head.appendChild(css);

  const ICO = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" stroke-linejoin="round"
    stroke-linecap="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>`;

  // ---------- controles sobre el mapa (botón + panel)
  class ControlEditar {
    onAdd() {
      this.c = document.createElement("div");
      this.c.className = "maplibregl-ctrl maplibregl-ctrl-group";
      this.c.innerHTML = `<button class="ctl-ed" title="Editar capas (sistemas y ciclovías existentes)"
        aria-label="Editar capas" aria-pressed="false">${ICO}</button>`;
      this.c.querySelector("button").onclick = () => {
        const p = $("edPanel");
        if (ed.capa) { p.hidden = !p.hidden; return; }   // editando: sólo muestra u oculta el panel
        p.hidden = !p.hidden;
        this.c.querySelector("button").setAttribute("aria-pressed", !p.hidden);
        if (!p.hidden) panelInicio();
      };
      return this.c;
    }
    onRemove() { this.c.remove(); }
  }
  class ControlPanelEd {
    onAdd() {
      this.c = document.createElement("div");
      this.c.className = "maplibregl-ctrl ed-panel";
      this.c.id = "edPanel";
      this.c.hidden = true;
      // que la rueda y los clics en el panel no muevan el mapa
      ["wheel", "mousedown", "dblclick", "touchstart"].forEach(t => this.c.addEventListener(t, e => e.stopPropagation()));
      return this.c;
    }
    onRemove() { this.c.remove(); }
  }

  fetch("api/estado", { headers: H }).then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !j.edicion) return;
    map.addControl(new ControlEditar(), "top-left");
    map.addControl(new ControlPanelEd(), "top-left");
  }).catch(() => {});   // abierto con doble clic o desde GitHub Pages: sin edición

  function panelInicio(msg = "") {
    $("edPanel").innerHTML = `<h3>Editar capa</h3>
      <div class="ed-ayuda">Los cambios se guardan en el archivo de la capa (se deja un respaldo en la carpeta
        <i>respaldos</i>) y se vuelve a calcular el análisis de red.</div>
      <div class="ed-capas">
        <button data-capa="sistemas">Sistemas</button>
        <button data-capa="existentes">Ciclovías existentes</button>
      </div><div class="ed-msg" id="edMsg">${msg}</div>`;
    $("edPanel").querySelectorAll("[data-capa]").forEach(b => b.onclick = () => empezar(b.dataset.capa));
  }

  function mensaje(html, error = false) {
    const m = $("edMsg");
    if (!m) return;
    m.innerHTML = html;
    m.classList.toggle("err", error);
  }

  // ---------- carga de la librería de dibujo (sólo al empezar a editar)
  let libPromesa = null;
  function cargarLib() {
    if (window.MapboxDraw) return Promise.resolve();
    return libPromesa ??= new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = DRAW_JS;
      s.onload = ok;
      s.onerror = () => { libPromesa = null; mal(new Error("no se pudo cargar la herramienta de dibujo (¿sin internet?)")); };
      document.head.appendChild(s);
    });
  }

  const estilos = color => [
    { id: "ed-linea", type: "line", filter: ["all", ["==", "$type", "LineString"], ["==", "active", "false"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": 3, "line-opacity": 0.9 } },
    { id: "ed-linea-activa", type: "line", filter: ["all", ["==", "$type", "LineString"], ["==", "active", "true"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#f08c00", "line-width": 4.5 } },
    { id: "ed-medio", type: "circle", filter: ["all", ["==", "meta", "midpoint"], ["==", "$type", "Point"]],
      paint: { "circle-radius": 3.5, "circle-color": "#f08c00", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } },
    { id: "ed-vertice", type: "circle", filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["==", "active", "false"]],
      paint: { "circle-radius": 4.5, "circle-color": "#fff", "circle-stroke-color": "#0b0b0b", "circle-stroke-width": 1.5 } },
    { id: "ed-vertice-activo", type: "circle", filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["==", "active", "true"]],
      paint: { "circle-radius": 6, "circle-color": "#d03b3b", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } },
  ];

  // ---------- ajuste (snap) a vértices y bordes de ambas capas
  function cacheSnap() {
    if (ed.snapCache) return ed.snapCache;
    const lineas = [];
    const agregar = (geom, id) => {
      if (!geom) return;
      const partes = geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
      partes.forEach((c, k) => {   // k: n.º de parte (en tramos MultiLineString)
        if (c.length < 2) return;
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of c) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
        lineas.push({ id, c, b, k });
      });
    };
    ed.draw.getAll().features.forEach(f => agregar(f.geometry, f.id));
    (ed.capa === "sistemas" ? D.geo.existentes : D.geo.sistemas).features.forEach(f => agregar(f.geometry, null));
    return (ed.snapCache = lineas);
  }
  function buscarSnap(pt, excluir) {
    const r = SNAP_PX;
    const a = map.unproject([pt.x - r, pt.y + r]), b = map.unproject([pt.x + r, pt.y - r]);
    let vert = null, dv = r, borde = null, db = r;
    for (const L of cacheSnap()) {
      if (excluir && L.id === excluir) continue;
      if (L.b[0] > b.lng || L.b[2] < a.lng || L.b[1] > b.lat || L.b[3] < a.lat) continue;
      let prev = null;
      for (const c of L.c) {
        const p = map.project([c[0], c[1]]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < dv) { dv = d; vert = c; }
        if (prev) {
          const dx = p.x - prev.x, dy = p.y - prev.y, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((pt.x - prev.x) * dx + (pt.y - prev.y) * dy) / l2)) : 0;
          const q = { x: prev.x + t * dx, y: prev.y + t * dy };
          const dq = Math.hypot(q.x - pt.x, q.y - pt.y);
          if (dq < db) { db = dq; borde = q; }
        }
        prev = p;
      }
    }
    if (vert) return { lng: vert[0], lat: vert[1] };
    if (borde) { const ll = map.unproject([borde.x, borde.y]); return { lng: ll.lng, lat: ll.lat }; }
    return null;
  }
  function marcaSnap(s) {
    const src = map.getSource("ed-snap");
    if (src) src.setData({ type: "FeatureCollection", features: s ?
      [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [s.lng, s.lat] } }] : [] });
  }
  function ajustarEvento(e, excluir) {
    const s = ed.snap && !e.originalEvent?.altKey ? buscarSnap(e.point, excluir) : null;   // Alt: sin ajuste
    if (s) e.lngLat = new maplibregl.LngLat(s.lng, s.lat);
    marcaSnap(s);
  }
  // modo "dibujar línea" con ajuste
  function lineaConSnap(base) {
    const m = Object.assign({}, base);
    for (const k of ["onMouseMove", "onClick", "onTap"]) {
      if (!base[k]) continue;
      m[k] = function (state, e) { ajustarEvento(e, state.line && state.line.id); return base[k].call(this, state, e); };
    }
    m.onStop = function (state) { marcaSnap(null); return base.onStop && base.onStop.call(this, state); };
    return m;
  }
  // modo "editar vértices" con ajuste al arrastrar un vértice
  function verticesConSnap(base) {
    const m = Object.assign({}, base);
    m.onDrag = function (state, e) {
      const r = base.onDrag.call(this, state, e);
      if (state.canDragMove && state.selectedCoordPaths && state.selectedCoordPaths.length === 1) {
        const s = ed.snap && !e.originalEvent?.altKey ? buscarSnap(e.point, state.featureId) : null;
        const p = s || e.lngLat;
        state.feature.updateCoordinate(state.selectedCoordPaths[0], p.lng, p.lat);
        marcaSnap(s);
      }
      return r;
    };
    m.onMouseUp = function (state, e) { marcaSnap(null); return base.onMouseUp && base.onMouseUp.call(this, state, e); };
    m.onStop = function (state) { marcaSnap(null); return base.onStop && base.onStop.call(this, state); };
    return m;
  }

  // ---------- cortar un tramo en dos (p. ej. dos cortes y borrar el tramo del medio)
  // punto de la capa en edición más cercano al cursor: tramo, parte k, segmento j y, si cae sobre un vértice, su índice
  function buscarCorte(pt) {
    let mejor = null, dmin = SNAP_PX;
    for (const L of cacheSnap()) {
      if (!L.id) continue;   // sólo la capa en edición
      for (let j = 0; j < L.c.length - 1; j++) {
        const A = map.project(L.c[j].slice(0, 2)), B = map.project(L.c[j + 1].slice(0, 2));
        const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((pt.x - A.x) * dx + (pt.y - A.y) * dy) / l2)) : 0;
        const d = Math.hypot(A.x + t * dx - pt.x, A.y + t * dy - pt.y);
        if (d >= dmin) continue;
        dmin = d;
        const len = Math.sqrt(l2);
        const iv = t * len < 3 ? j : (1 - t) * len < 3 ? j + 1 : null;   // a menos de 3 px de un vértice: se corta en él
        const [ax, ay] = L.c[j], [bx, by] = L.c[j + 1];
        const p = iv != null ? { lng: L.c[iv][0], lat: L.c[iv][1] } : { lng: ax + t * (bx - ax), lat: ay + t * (by - ay) };
        mejor = { id: L.id, k: L.k, j, iv, p };
      }
    }
    return mejor;
  }
  function cortar(h) {
    const f = ed.draw.get(h.id);
    const multi = f.geometry.type === "MultiLineString";
    const partes = multi ? f.geometry.coordinates : [f.geometry.coordinates];
    const linea = partes[h.k], P = [h.p.lng, h.p.lat];
    const A = h.iv != null ? linea.slice(0, h.iv + 1) : [...linea.slice(0, h.j + 1), P];
    const B = h.iv != null ? linea.slice(h.iv) : [P, ...linea.slice(h.j + 1)];
    if (A.length < 2 || B.length < 2) { mensaje("Ese punto es el extremo del tramo: no hay nada que cortar.", true); return; }
    const geom = c => multi ? { type: "MultiLineString", coordinates: c } : { type: "LineString", coordinates: c[0] };
    const largo = ed.campos.find(c => c.largo)?.nombre;
    const props1 = { ...f.properties }, props2 = { ...f.properties };
    delete props2._fid;
    if (largo) { props1[largo] = null; props2[largo] = null; }   // el largo de cada parte se calcula al guardar
    ed.draw.add({ type: "Feature", id: f.id, properties: props1, geometry: geom([...partes.slice(0, h.k), A]) });
    ed.draw.add({ type: "Feature", properties: props2, geometry: geom([B, ...partes.slice(h.k + 1)]) });
    if (ed.originales.has(f.id)) {
      ed.geom.add(f.id);
      if (largo) { if (!ed.attrs.has(f.id)) ed.attrs.set(f.id, new Set()); ed.attrs.get(f.id).add(largo); }
    }
    registrar();
    mensaje("Tramo cortado en dos. Para borrar un tramo intermedio, córtalo también en el otro extremo y luego " +
      "usa «Seleccionar», clic en el tramo del medio y «Borrar».");
  }
  const ModoCortar = {
    onSetup() { this.setActionableState({ trash: false }); this.updateUIClasses({ mouse: "add" }); return {}; },
    onMouseMove(state, e) { const h = buscarCorte(e.point); marcaSnap(h && h.p); this.updateUIClasses({ mouse: "add" }); },
    onClick(state, e) {
      const h = buscarCorte(e.point);
      if (h) cortar(h); else mensaje("Haz clic sobre un tramo de la capa para cortarlo.");
    },
    onTap(state, e) { this.onClick(state, e); },
    onKeyUp(state, e) { if (e.keyCode === 27) this.changeMode("simple_select"); },
    onStop() { marcaSnap(null); this.updateUIClasses({ mouse: "none" }); },
    toDisplayFeatures(state, geojson, display) { display(geojson); },
  };

  // ---------- empezar / terminar la edición
  async function empezar(capa) {
    if (typeof medir !== "undefined" && medir.modo) setModoMedir(null);
    if (typeof modoSV !== "undefined" && modoSV) setModoSV(false);
    mensaje("Cargando la capa…");
    let j;
    try {
      await cargarLib();
      const r = await fetch(`api/capa/${capa}`, { headers: H });
      j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
    } catch (err) {
      mensaje("No se pudo empezar a editar: " + esc(err.message), true);
      return;
    }
    Object.assign(ed, { capa, nombre: j.nombre, archivo: j.archivo, campos: j.campos, geom: new Set(), attrs: new Map(),
                        pila: [], sel: null, snapCache: null, visPrev: {} });
    j.geojson.features.forEach(f => { f.id = "f" + f.properties._fid; });
    ed.originales = new Set(j.geojson.features.map(f => f.id));

    document.querySelectorAll(".maplibregl-popup").forEach(p => p.remove());
    map.getCanvas().style.cursor = "";
    for (const id of OCULTAR[capa]) {
      if (!map.getLayer(id)) continue;
      ed.visPrev[id] = map.getLayoutProperty(id, "visibility") || "visible";
      vis(id, false);
    }
    const MD = window.MapboxDraw, cl = MD.constants.classes;
    Object.assign(cl, { CANVAS: "maplibregl-canvas", CONTROL_BASE: "maplibregl-ctrl", CONTROL_PREFIX: "maplibregl-ctrl-",
                        CONTROL_GROUP: "maplibregl-ctrl-group", ATTRIBUTION: "maplibregl-ctrl-attrib" });
    ed.draw = new MD({ displayControlsDefault: false, controls: {}, styles: estilos(COLOR[capa]), clickBuffer: 4,
      modes: { ...MD.modes, draw_line_string: lineaConSnap(MD.modes.draw_line_string),
               direct_select: verticesConSnap(MD.modes.direct_select), cortar: ModoCortar } });
    map.addControl(ed.draw, "top-right");
    ed.draw.set(j.geojson);
    if (!map.getSource("ed-snap")) {
      map.addSource("ed-snap", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "ed-snap", type: "circle", source: "ed-snap",
        paint: { "circle-radius": 7, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#d6198a", "circle-stroke-width": 2.5 } });
    }
    ed.ultimo = foto();
    map.on("draw.create", alCrear);
    map.on("draw.update", alActualizar);
    map.on("draw.delete", alBorrar);
    map.on("draw.selectionchange", alSeleccionar);
    map.on("draw.modechange", refrescar);
    panelEdicion();
  }

  function terminar() {
    if (pendientes().total && !confirm("Hay cambios sin guardar. ¿Salir y descartarlos?")) return;
    map.off("draw.create", alCrear); map.off("draw.update", alActualizar); map.off("draw.delete", alBorrar);
    map.off("draw.selectionchange", alSeleccionar); map.off("draw.modechange", refrescar);
    map.removeControl(ed.draw);
    if (map.getLayer("ed-snap")) map.removeLayer("ed-snap");
    if (map.getSource("ed-snap")) map.removeSource("ed-snap");
    for (const [id, v] of Object.entries(ed.visPrev)) vis(id, v === "visible");
    Object.assign(ed, { capa: null, draw: null, pila: [], ultimo: null, sel: null, snapCache: null });
    panelInicio();
  }

  // ---------- registro de cambios y deshacer
  function foto() {
    return { fc: ed.draw.getAll(), geom: new Set(ed.geom),
             attrs: new Map([...ed.attrs].map(([k, v]) => [k, new Set(v)])), sel: ed.sel };
  }
  function registrar() {
    ed.pila.push(ed.ultimo);
    if (ed.pila.length > MAX_DESHACER) ed.pila.shift();
    ed.ultimo = foto();
    ed.snapCache = null;
    refrescar();
  }
  function deshacer() {
    const f = ed.pila.pop();
    if (!f) return;
    ed.draw.changeMode("simple_select");
    ed.draw.set(structuredClone(f.fc));
    ed.geom = new Set(f.geom);
    ed.attrs = new Map([...f.attrs].map(([k, v]) => [k, new Set(v)]));
    ed.ultimo = f;
    ed.snapCache = null;
    ed.sel = f.sel && ed.draw.get(f.sel) ? f.sel : null;
    if (ed.sel) ed.draw.changeMode("simple_select", { featureIds: [ed.sel] });
    refrescar();
  }
  function alCrear(e) {
    for (const f of e.features)   // tramo nuevo: campos vacíos (se completan en el formulario)
      for (const c of ed.campos) if (!c.largo) ed.draw.setFeatureProperty(f.id, c.nombre, null);
    ed.sel = e.features[0]?.id ?? ed.sel;
    registrar();
    mensaje(ed.campos.some(c => c.obligatorio) ? "Tramo creado. Completa los campos marcados con *." : "Tramo creado.");
  }
  function alActualizar(e) {
    for (const f of e.features) if (ed.originales.has(f.id)) ed.geom.add(f.id);
    registrar();
  }
  function alBorrar() { ed.sel = null; registrar(); }
  function alSeleccionar(e) {
    const ids = e.features.map(f => f.id);
    ed.sel = ids.length === 1 ? ids[0] : null;
    ed.nSel = ids.length;
    refrescar();
  }

  function pendientes() {
    if (!ed.draw) return { total: 0 };
    const todos = ed.draw.getAll().features, ids = new Set(todos.map(f => f.id));
    const nuevos = todos.filter(f => !ed.originales.has(f.id));
    const borrados = [...ed.originales].filter(id => !ids.has(id));
    const mod = todos.filter(f => ed.originales.has(f.id) && (ed.geom.has(f.id) || ed.attrs.has(f.id)));
    return { todos, nuevos, borrados, mod, total: nuevos.length + borrados.length + mod.length };
  }

  // ---------- panel de edición
  const AYUDA = {
    simple_select: "Clic en un tramo para seleccionarlo y ver sus atributos. Clic otra vez sobre el tramo seleccionado " +
      "(o «Vértices») para editar su forma. Mayús + clic: varios tramos. Supr: borrar lo seleccionado.",
    direct_select: "Arrastra un vértice para moverlo; arrastra un punto naranjo (punto medio) para agregar un vértice. " +
      "Clic en un vértice y Supr (o «Borrar») para eliminarlo. Clic fuera del tramo para terminar.",
    draw_line_string: "Clic para agregar vértices; doble clic, Enter o clic en el último vértice para terminar; Esc cancela.",
    cortar: "Clic sobre un tramo para cortarlo en dos en ese punto (el círculo rosado muestra dónde). Para borrar un tramo " +
      "intermedio: corta en sus dos extremos, luego «Seleccionar», clic en el tramo del medio y «Borrar». Esc termina.",
  };
  function panelEdicion() {
    $("edPanel").innerHTML = `<h3>Editando: ${esc(ed.nombre)} <small id="edN"></small></h3>
      <div class="ed-barra">
        <button data-h="sel" title="Seleccionar tramos">↖ Seleccionar</button>
        <button data-h="vert" title="Mover, agregar o borrar vértices del tramo seleccionado">◇ Vértices</button>
        <button data-h="nuevo" title="Dibujar un tramo nuevo">✎ Nuevo tramo</button>
        <button data-h="cortar" title="Cortar un tramo en dos (para borrar un tramo intermedio)">✂ Cortar</button>
        <button data-h="borrar" title="Borrar el tramo (o los vértices) seleccionado (Supr)">✕ Borrar</button>
        <button data-h="deshacer" title="Deshacer el último cambio (Ctrl+Z)">↶ Deshacer</button>
        <button data-h="zoom" title="Acercar al tramo seleccionado">⌖ Acercar</button>
      </div>
      <label class="ed-chk"><input type="checkbox" id="edSnap" ${ed.snap ? "checked" : ""}>
        Ajustar a vértices y bordes cercanos (mantén Alt para no ajustar)</label>
      <div class="ed-ayuda" id="edAyuda"></div>
      <div class="ed-sec" id="edForm"></div>
      <div class="ed-pie"><span id="edCambios"></span>
        <button data-h="salir">Salir</button><button class="prim" data-h="guardar">Guardar</button></div>
      <div class="ed-msg" id="edMsg"></div>`;
    const acc = {
      sel: () => ed.draw.changeMode("simple_select", ed.sel ? { featureIds: [ed.sel] } : {}),
      vert: () => ed.sel ? ed.draw.changeMode("direct_select", { featureId: ed.sel })
        : mensaje("Selecciona primero un tramo (clic sobre él)."),
      nuevo: () => { ed.draw.changeMode("draw_line_string"); refrescar(); },
      cortar: () => { ed.draw.changeMode("cortar"); refrescar(); },
      borrar: () => {
        const modo = ed.draw.getMode();
        if (modo === "direct_select" || ed.draw.getSelectedIds().length) ed.draw.trash();
        else mensaje("No hay nada seleccionado para borrar.");
      },
      deshacer,
      zoom: () => { const f = ed.sel && ed.draw.get(ed.sel); if (f) map.fitBounds(bbox({ features: [f] }), { padding: 80, maxZoom: 18 }); },
      salir: terminar,
      guardar,
    };
    $("edPanel").querySelectorAll("[data-h]").forEach(b => b.onclick = () => acc[b.dataset.h]());
    $("edSnap").onchange = e => { ed.snap = e.target.checked; };
    refrescar();
  }

  function refrescar() {
    if (!ed.capa || !$("edAyuda")) return;
    const modo = ed.draw.getMode();
    $("edAyuda").textContent = AYUDA[modo] || "";
    const marcar = { sel: modo === "simple_select", vert: modo === "direct_select", nuevo: modo === "draw_line_string",
                     cortar: modo === "cortar" };
    $("edPanel").querySelectorAll("[data-h]").forEach(b => {
      if (b.dataset.h in marcar) b.setAttribute("aria-pressed", marcar[b.dataset.h]);
    });
    $("edPanel").querySelector('[data-h="deshacer"]').disabled = !ed.pila.length || ed.guardando;
    $("edPanel").querySelector('[data-h="vert"]').disabled = !ed.sel;
    $("edPanel").querySelector('[data-h="zoom"]').disabled = !ed.sel;
    const p = pendientes();
    $("edN").textContent = `${p.todos.length} tramos`;
    const det = [p.nuevos.length && `${p.nuevos.length} nuevo${p.nuevos.length > 1 ? "s" : ""}`,
                 p.mod.length && `${p.mod.length} modificado${p.mod.length > 1 ? "s" : ""}`,
                 p.borrados.length && `${p.borrados.length} borrado${p.borrados.length > 1 ? "s" : ""}`].filter(Boolean);
    $("edCambios").textContent = p.total ? `Sin guardar: ${det.join(", ")}` : "Sin cambios";
    $("edPanel").querySelector('[data-h="guardar"]').disabled = !p.total || ed.guardando;
    formulario();
  }

  function formulario() {
    const box = $("edForm");
    const f = ed.sel && ed.draw.get(ed.sel);
    if (!f) {
      box.innerHTML = `<div class="ed-ayuda" style="margin:0">${ed.nSel > 1 ? `${ed.nSel} tramos seleccionados.` :
        "Selecciona un tramo para ver y editar sus atributos."}</div>`;
      return;
    }
    if (box.dataset.id === f.id && box.contains(document.activeElement)) return;   // no interrumpir mientras se escribe
    box.dataset.id = f.id;
    const nuevo = !ed.originales.has(f.id);
    box.innerHTML = `<div class="ed-ftit">${nuevo ? "Tramo nuevo" : `Tramo n.º ${f.properties._fid + 1}`}</div>` +
      ed.campos.map((c, i) => `<label class="ed-campo" title="${esc(c.nombre)}"><span>${esc(c.nombre)}${c.obligatorio ? " *" : ""}</span>
        <input data-k="${esc(c.nombre)}" value="${esc(f.properties[c.nombre])}" ${c.tipo === "numero" ? 'inputmode="decimal"' : ""}
          ${c.valores.length ? `list="edL${i}"` : ""} ${c.largo && nuevo ? 'placeholder="se calcula al guardar"' : ""}
          class="${c.obligatorio && (f.properties[c.nombre] ?? "") === "" ? "mal" : ""}">
        ${c.valores.length ? `<datalist id="edL${i}">${c.valores.map(v => `<option value="${esc(v)}">`).join("")}</datalist>` : ""}
      </label>`).join("");
    box.querySelectorAll("input").forEach(inp => inp.onchange = () => {
      const k = inp.dataset.k, c = ed.campos.find(x => x.nombre === k), v = inp.value.trim();
      if (c.tipo === "numero" && v !== "" && isNaN(Number(v.replace(",", ".")))) {
        inp.classList.add("mal"); mensaje(`«${esc(k)}» debe ser un número.`, true); return;
      }
      inp.classList.toggle("mal", c.obligatorio && v === "");
      mensaje("");
      ed.draw.setFeatureProperty(f.id, k, v === "" ? null : v);
      if (!ed.attrs.has(f.id)) ed.attrs.set(f.id, new Set());
      ed.attrs.get(f.id).add(k);
      registrar();
    });
  }

  // ---------- guardar
  async function guardar() {
    const p = pendientes();
    if (!p.total) return;
    const obligatorios = ed.campos.filter(c => c.obligatorio).map(c => c.nombre);
    const incompleto = [...p.nuevos, ...p.mod].find(f => obligatorios.some(k => (f.properties[k] ?? "") === ""));
    if (incompleto) {
      ed.draw.changeMode("simple_select", { featureIds: [incompleto.id] });
      ed.sel = incompleto.id; refrescar();
      mensaje(`Falta completar ${obligatorios.map(k => `«${esc(k)}»`).join(" y ")} en el tramo seleccionado.`, true);
      return;
    }
    if (p.borrados.length && !confirm(`Se borrarán ${p.borrados.length} tramo(s) de la capa ${ed.nombre}. ¿Continuar?`)) return;
    const fid = id => +id.slice(1);
    const cuerpo = {
      borrados: p.borrados.map(fid),
      modificados: p.mod.map(f => ({ _fid: fid(f.id), geometria: ed.geom.has(f.id) ? f.geometry : null,
        atributos: Object.fromEntries([...(ed.attrs.get(f.id) || [])].map(k => [k, f.properties[k] ?? null])) })),
      nuevos: p.nuevos.map(f => ({ geometria: f.geometry,
        atributos: Object.fromEntries(ed.campos.map(c => [c.nombre, f.properties[c.nombre] ?? null])) })),
    };
    ed.guardando = true;
    ed.draw.changeMode("simple_select");
    refrescar();
    mensaje("Guardando y recalculando el análisis de red… puede tardar uno o dos minutos. No cierres la ventana negra.");
    try {
      const r = await fetch(`api/capa/${ed.capa}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
                                                       body: JSON.stringify(cuerpo) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      if (!j.ok) {   // la capa ya se guardó: los botones quedan desactivados para no volver a enviar lo mismo
        mensaje(`La capa se guardó (respaldo en <i>${esc(j.resumen.respaldo)}</i>), pero el análisis de red falló.
          Revisa el error y vuelve a cargar la página:<pre>${esc(j.log)}</pre>
          <button onclick="location.reload()">Volver a cargar</button>`, true);
        return;
      }
      mensaje("Guardado. Recargando el visor con el análisis actualizado…");
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      ed.guardando = false;
      refrescar();
      mensaje("No se pudo guardar: " + esc(err.message) + ". Los cambios siguen en pantalla; puedes reintentar.", true);
    }
  }

  // ---------- teclado y salida con cambios pendientes
  document.addEventListener("keydown", e => {
    if (!ed.capa || ed.guardando) return;
    const enCampo = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !enCampo) { e.preventDefault(); deshacer(); }
  });
  window.addEventListener("beforeunload", e => {
    if (ed.capa && !ed.guardando && pendientes().total) { e.preventDefault(); e.returnValue = ""; }
  });
})();

@echo off
rem Abre el visor desde un servidor local (http://localhost) en vez de doble clic en index.html.
rem Así el navegador se identifica ante OpenStreetMap y Google y los mapas base cargan.
rem Además habilita la edición de las capas de sistemas y ciclovías existentes (botón del lápiz).
rem Para cerrar el visor: cerrar esta ventana negra.
cd /d "%~dp0"
rem servidor.py abre el navegador en http://localhost:8765/index.html cuando está listo
python servidor.py
pause

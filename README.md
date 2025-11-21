# MAQ IMPRENTA Panel

## Despliegue rápido
1. Instala dependencias `npm install` (Node.js >= 18 recomendado).
2. Copia `config.example.js` a `config.js` y rellena tu configuración Firebase pública.
3. Crea un archivo `.env` basado en `.env.example` y establece las variables descritas abajo.
4. Arranca el backend Express con `node server.js` (o `npm run start`).
5. Abre `http://localhost:3000/` (no uses `file://` porque la SPA llama a `/api/*`).
6. Configura reglas Firestore endurecidas (ver sección Seguridad).

## Variables de entorno `.env`
| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `PORT` | No (default 3000) | Puerto HTTP del servidor Express. |
| `APP_API_KEY` | Sí en prod | Clave requerida en cabecera `x-app-key` para todas las rutas `/api`. Guarda una distinta por entorno. |
| `FORCE_API_KEY` | No (default `true` en prod) | Si vale `true`, el backend exige `APP_API_KEY` y rechaza el arranque si falta. Establece `false` sólo para entornos cerrados o pruebas manuales. |
| `ALLOW_DEMO` | No (default `false`) | Permite endpoints de demo/semilla (`/api/restock/:fecha/demo`). Actívala explícitamente cuando los necesites. |
| `NODE_ENV` | No | Usa `production` en despliegues para forzar desactivar demo por defecto. |
| `FIREBASE_SERVICE_ACCOUNT_FILE` / `FIREBASE_*` | Sí | Credenciales Admin SDK (ruta a JSON o variables inline). |
| `META_*` | Opcional | Token y configuración de WhatsApp Cloud API (ver sección dedicada). |
| `CASH_DRAWER_HOOK_URL` | Opcional | Webhook para apertura automática de cajón. |
| `PO_ALERT_WHATSAPP` / `PO_ALERT_RECIPIENTS` | Opcional | Lista separada por comas de teléfonos (solo dígitos) que recibirán alertas WhatsApp de OCs vencidas. |
| `PO_ALERT_CRON` | Opcional | Expresión cron para barrido automático de OCs (ej. `0 8 * * *`). Usa `off` para desactivar. |
| `PO_ALERT_TZ` | Opcional | Zona horaria IANA para el cron de alertas (default `America/Mexico_City`). |
| `PO_ALERT_DRY_RUN` | Opcional | `true` para registrar alertas sin enviarlas (útil en staging). |

> Recomendación: en producción define `APP_API_KEY`, deja `FORCE_API_KEY` en `true` (default con `NODE_ENV=production`) y establece `ALLOW_DEMO=false`. El front guardará la key en `sessionStorage` y la incluirá automáticamente en cada `fetch`.

## Ejecución local
```powershell
npm install
node server.js
# o
npm run dev
```

- El servidor expone `/health` y `/api/_buildinfo` para diagnóstico (build, flags demo/API key, credenciales Firebase).
- Usa la tarea `node tools/parse_script.js` para validar que `script.js` no tenga errores de sintaxis tras cambios.
- El botón “Eventos” en Reabastecimiento consulta `/api/event-log`; ajusta el límite con `eventLogLimit` (10–200).

## Despliegue producción (sugerido)
1. Configura la app detrás de un proxy (Nginx/Apache) que fuerce HTTPS.
2. Define `APP_API_KEY` larga (≥32 chars) y guarda la clave en tu administrador seguro.
3. Establece `ALLOW_DEMO=false` para bloquear endpoints de prueba.
4. Ejecuta con `pm2`, `systemd` o contenedor Docker (`node server.js` o `npm run start`).
5. Monitorea logs (`event_log` en Firestore + stdout). Exporta la colección a BigQuery/Storage periódicamente.
6. Programa respaldos de Firestore (CLI o Cloud Scheduler) y rotación de API key.

## QA End-to-End
- Antes de liberar cambios ejecuta la batería descrita en `docs/qa-checklist.md`.
- Ejecuta el smoke test automatizado con `npm run qa:smoke` (configura `QA_SMOKE_BASE_URL` y `QA_SMOKE_API_KEY` según el entorno).
- Registra hallazgos en `docs/qa-run-log.md` y actualiza `docs/deployment-guide.md` si surgen pasos adicionales.
- Mantén `PO_ALERT_DRY_RUN=true` en staging para no enviar mensajes reales salvo que el plan QA lo requiera.

## Características
- Ventas con parcialidades, abonos y cancelación.
- Caja: ingresos, gastos, retiros, corte y reportes Ingresos vs Gastos.
- Corte de caja automático ahora a medianoche (TZ México) si el usuario no lo realizó manualmente; genera resumen diario.
- Cuentas por cobrar (aging buckets). 
- Cotizaciones -> conversión a venta.
- Facturas borrador / emisión interna (timbrado aún simulado).
- Producción: listado + calendario y programación (colección `produccion_programada`).
- Backup JSON manual de catálogos y ventas meta.

## Archivos clave
- `index.html` UI principal.
- `firebase.js` capa Firebase (listeners + APIs dominio).
- `script.js` lógica UI y agregaciones.
- `config.js` (no versionado) define `window.__FIREBASE_CONFIG__`.

## Seguridad / Hardening pendiente
- Reglas para colecciones nuevas: `produccion_programada`, `caja_movimientos`, `facturas` deben validar rol y campos.
- Limitar escritura de `usuarios` a admins.
- Validar invariantes: `venta.total == venta.pagado + venta.saldo` (ya reforzado en reglas y transacciones; revisar reglas).
- Timbrado real: integrar PAC (CFDI 4.0) vía backend (Cloud Functions) para sellado y timbrado; nunca exponer llave .key en front.

## Próximos pasos sugeridos
1. Implementar Cloud Function `cfdiTimbrar` que reciba factura (id) y realice timbrado.
2. Endpoint para cancelar CFDI con motivo.
3. Export automático (programado) de respaldo a Cloud Storage (diario).
4. Auditoría mejorada: index compuestos por `action+entity` para consultas.
5. Integrar eventos `produccion_programada` en render de calendario.
6. (Opcional) Migrar corte automático a Cloud Function programada (Pub/Sub) para alta disponibilidad.

> Consulta `docs/deployment-guide.md` para un procedimiento detallado de despliegue, pruebas y contingencia.

## Corte de caja automático (Midnight)
El backend Express programa un cron a las 00:00 (America/Mexico_City). Al disparar:
1. Calcula el día anterior (ayer) y agrega un documento por caja en `caja_cortes` (espejo en `corte_caja`).
2. Campo `mode` se registra como `auto_midnight` (o `auto_midnight_catchup` si fue generado al reiniciar porque faltaba).
3. Si ya existe (idempotencia por `cajaId-fecha`) se omite.

Catch-up al arrancar: si el servidor se inicia después de medianoche y no existe corte de ayer, lo genera inmediatamente.

Forzar corte manual (mismo formato): usar el endpoint POST `/caja/run-daily-cut` con header `x-corte-secret` (si configurado) y parámetros opcionales `date` (YYYY-MM-DD) y `force=true`.

## Desarrollo local
Abrir en navegador un servidor estático (ej. VSCode Live Server). Requiere conexión a Internet para CDNs.

## Nota
Este panel usa la versión namespaced (Firebase 8) para compatibilidad rápida. Migrar a SDK modular v10+ cuando el código esté estabilizado.

## WhatsApp Cloud API (Configuración backend)
1. Crea un archivo `.env` en la raíz (puedes copiar `.env.example`).
2. Llena:
	- `META_WHATSAPP_TOKEN` token largo de la app (no el temporal corto si ya generaste el largo).
	- `META_PHONE_NUMBER_ID` ID numérico (no el número de teléfono). Está en el dashboard Quick Start.
	- Opcional `META_GRAPH_VERSION` (default v22.0).
3. Reinicia el servidor Express (`npm run dev`).
4. Verifica en `http://localhost:3000/health` -> `hasToken: true`, `phoneConfigured: true`.
5. Verifica en `http://localhost:3000/whatsapp-diagnose` que retorna `phoneData` válido.
6. Usa la sección “API WhatsApp” del front para enviar:
	- Texto: modo "Texto simple".
	- Plantilla: modo "Template" (ej: hello_world / en_US).

### Alertas automáticas de órdenes de compra vencidas
1. Define `PO_ALERT_WHATSAPP` (o `PO_ALERT_RECIPIENTS`) con una o varias cuentas WhatsApp, por ejemplo `5215551234567,5213337654321`.
2. Ajusta `PO_ALERT_CRON` si deseas un barrido diario (ej. `0 7 * * *` para las 07:00). Con `off` solo se evalúa al cargar la UI o reiniciar el backend.
3. Opcional: marca `PO_ALERT_DRY_RUN=true` mientras pruebas; verás registros en `event_log` sin mensajes reales.
4. El backend marca `purchase_orders.overdue=true`, crea eventos `purchase_order_overdue` y dispara el mensaje “⚠️ Orden de compra vencida…”.
5. Cada envío se refleja en `event_log` (`purchase_order_overdue_alert_sent` / `_error`) para trazabilidad.

#### Checklist de verificación rápida
- `PO_ALERT_DRY_RUN=true` y `PO_ALERT_WHATSAPP` con tu número de prueba.
- Crear OC con ETA pasada y status PENDIENTE; recargar módulo Compras.
- Confirmar en `event_log` entradas `purchase_order_overdue` y `purchase_order_overdue_alert_sent` (con `dryRun=true`).
- Ajustar ETA a futura o cerrar la OC; verificar evento `purchase_order_overdue_cleared`.
- Desactivar `dry-run` cuando pases a producción.

Errores comunes 500:
| Causa | Síntoma |
|-------|---------|
| Token expirado/incorrecto | Error 401 OAuthException |
| PHONE_NUMBER_ID incorrecto | Error 100 Unsupported post request |
| Plantilla no aprobada | Código 132000 / 470 con descripción template |
| Destino no válido | Error 131026 / invalid recipient |
| Falta iniciar ventana 24h | Solo plantillas aprobadas se aceptan primero |

Si falla: revisa consola backend (logs [WA]) y la respuesta JSON mostrada en el panel.


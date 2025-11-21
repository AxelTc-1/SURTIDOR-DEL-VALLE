# Índices Firestore recomendados

Crea estos índices compuestos en la consola de Firestore (Database > Indexes > Composite > Add Index). Para cada colección agrega las combinaciones.

Formato: collection | fields (order)

## ventas
- clienteId ASC, fecha DESC
- statusProd ASC, fecha DESC
- categoriaProd ASC, fecha DESC
- compromiso ASC, statusProd ASC
- clienteId ASC, status ASC, fecha DESC

## facturas
- clienteId ASC, fecha DESC
- folio DESC, clienteId ASC

## cotizaciones
- clienteId ASC, folio DESC

## pagos
- clienteId ASC, fecha DESC

## pedidos_proveedor
- proveedorId ASC, fechaCreacion DESC

 

## caja_movimientos
- tipo ASC, fecha DESC

## caja_cortes
- fecha DESC
- cajaId ASC, fecha DESC

---

### JSON (referencial) para documentación
```json
[
  {"collection":"ventas","fields":[{"fieldPath":"clienteId","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"ventas","fields":[{"fieldPath":"statusProd","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"ventas","fields":[{"fieldPath":"categoriaProd","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"ventas","fields":[{"fieldPath":"compromiso","order":"ASCENDING"},{"fieldPath":"statusProd","order":"ASCENDING"}]},
  {"collection":"ventas","fields":[{"fieldPath":"clienteId","order":"ASCENDING"},{"fieldPath":"status","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"facturas","fields":[{"fieldPath":"clienteId","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"facturas","fields":[{"fieldPath":"folio","order":"DESCENDING"},{"fieldPath":"clienteId","order":"ASCENDING"}]},
  {"collection":"cotizaciones","fields":[{"fieldPath":"clienteId","order":"ASCENDING"},{"fieldPath":"folio","order":"DESCENDING"}]},
  {"collection":"pagos","fields":[{"fieldPath":"clienteId","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]},
  {"collection":"pedidos_proveedor","fields":[{"fieldPath":"proveedorId","order":"ASCENDING"},{"fieldPath":"fechaCreacion","order":"DESCENDING"}]},
  
  {"collection":"caja_movimientos","fields":[{"fieldPath":"tipo","order":"ASCENDING"},{"fieldPath":"fecha","order":"DESCENDING"}]}
]
```

> Nota: Si Firestore te muestra un error de índice faltante con una variante, copia esa definición exacta adicional. Ajusta TTL y segmentación si habilitas TTL/Analytics.

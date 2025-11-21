# Cloud Functions (Outline)

## Objetivos
1. Integridad: validar invariantes (ventas, facturas) server-side.
2. Auditoría programada: snapshots diarios a Storage.
3. KPIs: recalcular métricas y guardar en `metrics/diario`.
4. Alertas: enviar notificaciones si SLO/SLA violados (saldo CxC, folios).

## Dependencias sugeridas
- firebase-admin
- firebase-functions
- nodemailer (si correo SMTP) / Slack webhook / SendGrid.

## Estructura propuesta
```
functions/
  index.js
  kpi.js
  integrity.js
  alerts.js
  package.json
```

## Pseudocódigo principal (index.js)
```js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// Util: recalcula invariantes de venta
async function recomputeVenta(ventaId){
  const ref = db.collection('ventas').doc(ventaId);
  const snap = await ref.get(); if(!snap.exists) return;
  const v = snap.data();
  const abonosSnap = await ref.collection('abonos').get();
  let pagado = 0; abonosSnap.forEach(a=> pagado += a.data().monto||0);
  const saldo = parseFloat((v.total - pagado).toFixed(2));
  if(saldo < 0){ functions.logger.warn('Saldo negativo vente', ventaId, { total:v.total, pagado, saldo}); }
  const desired = { pagado, saldo, status: saldo>0?'PENDIENTE':'PAGADA' };
  // Solo actualiza si difiere
  if(v.pagado !== pagado || v.saldo !== saldo || v.status !== desired.status){
    await ref.set({ ...desired, integrityFixAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
  }
}

exports.onVentaAbonoWrite = functions.firestore
  .document('ventas/{ventaId}/abonos/{abonoId}')
  .onWrite(async (change, ctx)=>{ await recomputeVenta(ctx.params.ventaId); });

exports.onVentaCreate = functions.firestore
  .document('ventas/{ventaId}')
  .onCreate(async (snap, ctx)=>{ await recomputeVenta(ctx.params.ventaId); });

exports.onFacturaAbonoWrite = functions.firestore
  .document('facturas/{facturaId}/abonos/{abonoId}')
  .onWrite(async (change, ctx)=>{
    const ref = db.collection('facturas').doc(ctx.params.facturaId);
    const fSnap = await ref.get(); if(!fSnap.exists) return;
    const f = fSnap.data();
    const abonosSnap = await ref.collection('abonos').get();
    let abonado=0; abonosSnap.forEach(a=> abonado += a.data().monto||0);
    const saldo = parseFloat((f.total - abonado).toFixed(2));
    const patch = { abonado, saldo };
    if(f.abonado!==abonado || f.saldo!==saldo) await ref.set({ ...patch, integrityFixAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
  });

 

// Snapshot diario (00:15 UTC) - ajustar a timezone
exports.snapshotDaily = functions.pubsub.schedule('15 0 * * *').onRun(async ()=>{
  const date = new Date().toISOString().slice(0,10);
  const collections = ['ventas','facturas','productos','clientes'];
  const bucket = admin.storage().bucket();
  for(const c of collections){
    const arr=[]; const snap = await db.collection(c).limit(5000).get();
    snap.forEach(doc=> arr.push({ id: doc.id, ...doc.data() }));
    const file = bucket.file(`snapshots/${date}/${c}.json`);
    await file.save(JSON.stringify(arr));
  }
  return null;
});

// KPI horario (cada hora)
exports.kpiHourly = functions.pubsub.schedule('0 * * * *').onRun(async ()=>{
  const now = new Date(); const hour = now.toISOString().slice(0,13)+':00';
  // Simple: total ventas día
  const today = now.toISOString().slice(0,10);
  const ventasSnap = await db.collection('ventas').where('fecha','==',today).get();
  let total=0, margen=0; ventasSnap.forEach(d=>{ const v=d.data(); total+=v.total||0; margen+= (v.total||0)-(v.costoTotal||0); });
  await db.collection('metrics').doc('ventas_diarias').collection('horas').doc(hour).set({ total, margen, ts: admin.firestore.FieldValue.serverTimestamp() });
  return null;
});
```

## Próximos pasos
- Añadir alertas (saldo CxC > umbral) usando query agregada (necesario recorrer clientes).
- Integrar App Check en front.
- Tests con emulator: `firebase emulators:start --only functions,firestore`.

## Nota backend Express (no Function)
Actualmente el corte de caja automático se ejecuta vía cron en el servidor Express a las 00:00 (America/Mexico_City) generando el resumen del día anterior (`mode: auto_midnight`). Si se requiere alta disponibilidad y resiliencia a reinicios, se puede migrar a una Cloud Function programada (Pub/Sub) replicando la lógica de `computeAndPersistCorteForDate`.

// firebase.js - Inicializa Firebase y expone una capa mínima de persistencia
// Puedes ampliar este archivo para cubrir todos los módulos (ventas, clientes, etc.)

// --- Configuración proporcionada ---
// Nota: apiKey NO es secreta en apps web, pero se externaliza para facilitar despliegues multi-entorno.
// Reemplace window.__FIREBASE_CONFIG__ desde una etiqueta inline generada por el backend (o archivo config.js gitignored).
const firebaseConfig = window.__FIREBASE_CONFIG__ || {
  apiKey: "__API_KEY__",
  authDomain: "tcservidor-b8874.firebaseapp.com",
  projectId: "tcservidor-b8874",
  storageBucket: "tcservidor-b8874.firebasestorage.app",
  messagingSenderId: "1033968746876",
  appId: "1:1033968746876:web:d75c3247adc32f785864f9"
};

// Avisar si no se creó config.js con credenciales reales
if(firebaseConfig.apiKey === "__API_KEY__"){
  console.error('[Config] Falta config.js con credenciales reales de Firebase. Crea config.js copiando config.example.js.');
}

// --- Inicialización ---
window.initFirebaseApp = async function initFirebaseApp(){
  if(window._firebaseReady) return; // evitar doble init
  if(typeof firebase === 'undefined'){ console.warn('Firebase SDK no cargado todavía'); return; }
  try {
    firebase.initializeApp(firebaseConfig);
    window.auth = firebase.auth();
    window.db = firebase.firestore();
    // Fuerza long-polling para evitar bloqueos QUIC/HTTP3 (proxies, firewalls, etc.)
    try {
      if(!window.__dbSettingsApplied){
        const baseSettings = {
          experimentalForceLongPolling: true,
          experimentalAutoDetectLongPolling: false,
          useFetchStreams: false,
          ignoreUndefinedProperties: true,
          merge: true
        };
        const override = (window.__FIRESTORE_SETTINGS__ && typeof window.__FIRESTORE_SETTINGS__ === 'object')
          ? window.__FIRESTORE_SETTINGS__
          : null;
        window.db.settings(override ? { ...baseSettings, ...override } : baseSettings);
        window.__dbSettingsApplied = true;
      }
    } catch(err) {
      console.warn('[Firebase] Ajustes de Firestore no aplicados', err?.message || err);
    }
    // Autenticación anónima (opcional). Activa con window.__ALLOW_ANON_AUTH__=true en config si tus reglas requieren auth.
    try {
      if(window.__ALLOW_ANON_AUTH__===true && !window.auth.currentUser){
        await window.auth.signInAnonymously();
      }
    } catch(_e){ /* ignorar, UI de login seguirá disponible */ }
    try {
      await window.db.enablePersistence({ synchronizeTabs:true });
    } catch(e){
      console.warn('Persistencia offline no habilitada:', e.code||e.message);
      window._firestorePersistenceError = e.code || e.message;
      try {
        if(confirm('La caché de Firestore es incompatible (versión previa). ¿Limpiar ahora para reactivar modo offline?')){
          window.__autoClearedFirestoreCache = true;
          setTimeout(()=>{ if(window.clearFirestoreCache) window.clearFirestoreCache(); }, 150);
        }
      } catch(_c){ /* ignore */ }
    }
    window._firebaseReady = true;
    attachAuthListener();
    if(typeof attachRealtimeListeners === 'function') attachRealtimeListeners();
  } catch(e){
    console.error('[Firebase] Error al inicializar', e);
  }
}

// --- Colecciones base (ajusta nombres según convenga) ---
function col(name){ if(!window.db) return null; return window.db.collection(name); }

// Mapa simple: nombre lógico -> colección en Firestore
const collectionsMap = {
  productos: 'productos',
  insumos: 'insumos',
  categorias: 'categorias',
  gastoCategorias: 'gasto_categorias',
  clientes: 'clientes',
  cotizaciones: 'cotizaciones',
  facturas: 'facturas',
  sucursales: 'sucursales',
  pagos: 'pagos',
  proveedores: 'proveedores',
  cxpProveedores: 'cxp_proveedores',
  pedidosProveedor: 'pedidos_proveedor',
  maquinas: 'maquinas',
  compras: 'compras',
  counters: 'counters',
  caja: 'caja',
  cajaCortes: 'caja_cortes',
  usuarios: 'usuarios',
  cajas: 'coleccion_cajas',
  cajaTurnos: 'caja_turnos',
  consumiblesHistorial: 'consumibles_historial',
  unidadesMedida: 'unidades_medida',
  // Aprobaciones administrativas (solicitudes para acciones sensibles, p.ej. cancelar venta)
  adminApprovals: 'admin_approvals',
  puntosMedios: 'puntos_medios',
  
};

// =====================
// Configuración y utilidades de Turnos (AM/PM/COMPLETO)
// =====================
const __TURNOS_CFG__ = (function(){
  // Permite override desde window.__TURNOS_CFG__
  const def = {
    tz: window.__CORTE_TZ__ || 'America/Mexico_City',
    // Límites por defecto (puedes ajustar en config.js creando window.__TURNOS_CFG__)
    amStart: '09:00', amEnd: '14:59',
    pmStart: '15:00', pmEnd: '20:59',
    // Umbral para considerar turno corrido como COMPLETO por duración (minutos)
  fullMinMinutes: 7*60, // 7 horas
  // Si true, se parte automáticamente el turno AM->PM en el cambio de ventana; si false, permanece corrido
  autoSplit: true,
  };
  try { return { ...def, ...(window.__TURNOS_CFG__||{}) }; } catch(_e){ return def; }
})();

function parseHhmmToMinutes(hhmm){
  const m = String(hhmm||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1],10)||0));
  const mi = Math.min(59, Math.max(0, parseInt(m[2],10)||0));
  return h*60 + mi;
}
function minutesSinceMidnight(date, tz){
  try{
    const opt = { timeZone: tz, hour12: false, hour:'2-digit', minute:'2-digit' };
    const parts = new Intl.DateTimeFormat('en-GB', opt).formatToParts(date);
    const hh = parseInt((parts.find(p=>p.type==='hour')||{}).value||'0',10)||0;
    const mm = parseInt((parts.find(p=>p.type==='minute')||{}).value||'0',10)||0;
    return hh*60 + mm;
  }catch(_e){
    const d = new Date(date);
    return d.getHours()*60 + d.getMinutes();
  }
}
function formatDateYmd(date, tz){
  try { return new Intl.DateTimeFormat('en-CA',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(date); }
  catch(_e){ const d=new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
}

// Fecha de hoy en formato YYYY-MM-DD respetando zona horaria (por defecto MX)
function getTodayStrTZ(tz){
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz|| (window.__FECHA_TZ__ || 'America/Mexico_City'), year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
  catch(_e){ return new Date().toISOString().slice(0,10); }
}
// Exponer helper global para uso desde otros módulos si se requiere
try { if(!window.getTodayStrTZ) window.getTodayStrTZ = getTodayStrTZ; } catch(_e){}
function classifyTurnoInterval(openDate, closeDate, cfg=__TURNOS_CFG__){
  const tz = cfg.tz || 'America/Mexico_City';
  const amS = parseHhmmToMinutes(cfg.amStart), amE = parseHhmmToMinutes(cfg.amEnd);
  const pmS = parseHhmmToMinutes(cfg.pmStart), pmE = parseHhmmToMinutes(cfg.pmEnd);
  const dayOpenMin = minutesSinceMidnight(openDate, tz);
  const dayCloseMin = minutesSinceMidnight(closeDate, tz);
  // Duración aproximada
  const durationMin = Math.max(0, Math.round((closeDate - openDate)/60000));
  const jornada = formatDateYmd(openDate, tz);
  // Determinar si hay traslape con intervalos de AM/PM (simplificado al mismo día)
  function overlap(a1,a2,b1,b2){ return a1<=b2 && b1<=a2; }
  const amOverlap = amS!=null && amE!=null ? overlap(dayOpenMin, dayCloseMin, amS, amE) : false;
  const pmOverlap = pmS!=null && pmE!=null ? overlap(dayOpenMin, dayCloseMin, pmS, pmE) : false;
  let tipo = 'AM';
  if(amOverlap && pmOverlap) tipo = 'COMPLETO';
  else if(pmOverlap && !amOverlap) tipo = 'PM';
  else if(!amOverlap && !pmOverlap){
    // Fuera de ventanas declaradas: usar duración para decidir si fue completo o asignar por proximidad
    if(durationMin >= (cfg.fullMinMinutes||420)) tipo = 'COMPLETO';
    else tipo = (dayOpenMin < (pmS||900) ? 'AM' : 'PM');
  }
  return { tipo, durationMin, jornada, segments: { am: !!amOverlap, pm: !!pmOverlap } };
}

// Helper global: limpieza profunda de undefined dentro de objetos/arreglos
function deepClean(val){
  if(Array.isArray(val)) return val.map(deepClean).filter(v=> v !== undefined);
  // Solo recorrer objetos "planos"; preservar objetos especiales (FieldValue, Timestamp, GeoPoint, Date, etc.)
  const isPlainObject = (o)=> Object.prototype.toString.call(o) === '[object Object]' && (o?.constructor === Object || o?.constructor == null);
  if(val && isPlainObject(val)){
    const out = {};
    for(const k in val){ if(Object.prototype.hasOwnProperty.call(val,k)){
      const cleaned = deepClean(val[k]);
      if(cleaned !== undefined) out[k] = cleaned;
    }}
    return out;
  }
  return val === undefined ? undefined : val;
}

const MAX_PUNTOS_MEDIOS_GLOBAL = 50;

function buildPuntoMedioKey(pm){
  if(!pm) return '';
  const safe = (val)=> String(val||'').trim();
  const safeLower = (val)=> safe(val).toLowerCase();
  const name = safeLower(pm.nombre).replace(/\s+/g,' ');
  const coords = safe(pm.coords);
  const calle = safeLower(pm.calle);
  const numero = safeLower(pm.numero);
  const colonia = safeLower(pm.colonia);
  const cp = safe(pm.cp);
  const ciudad = safeLower(pm.ciudad);
  const estado = safeLower(pm.estado);
  const pais = safeLower(pm.pais);
  return [name, coords, calle, numero, colonia, cp, ciudad, estado, pais].join('|');
}

function hashStringToBase36(str){
  let hash = 2166136261;
  for(let i=0;i<str.length;i++){
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeDocIdSegment(segment){
  const cleaned = String(segment||'').replace(/[^A-Za-z0-9_-]/g,'_');
  return cleaned || 'anon';
}

function buildPuntoMedioDocId(clienteId, key){
  const prefix = sanitizeDocIdSegment(clienteId);
  const hash = hashStringToBase36(`${clienteId||''}::${key||''}`);
  return `${prefix}__${hash}`;
}

function normalizeUnidadTexto(value){
  return String(value == null ? '' : value).trim();
}

function normalizeUnidadFamiliaKey(value){
  try{
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/["'`´]/g, '')
      .replace(/[^A-Za-z0-9\s-]/g, ' ')
      .replace(/[_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }catch(_e){
    return String(value == null ? '' : value).trim().toLowerCase();
  }
}

function parseUnidadFactor(value){
  const num = Number(value);
  if(!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 1000000) / 1000000;
}

let attached = false;
function attachRealtimeListeners(){
  if(attached) return; attached = true;
  // Productos
  const cProd = col(collectionsMap.productos);
    if(cProd) {
  // Load all products to ensure accurate per-categoría counts
  // (was: orderBy('descripcionLower').limit(1000))
  cProd.onSnapshot(snap=>{
      const arr = [];
      snap.forEach(doc=>{ arr.push({ _id: doc.id, id: doc.id, ...doc.data() }); });
      // Limpiezas y normalizaciones ligeras (limitadas por sesión)
      try{
        arr.slice(0,200).forEach(p=>{
          const ref = col(collectionsMap.productos).doc(p._id);
          const precioVal = Number(p.precio);
          const precioPub = Number(p.precioPublico);
          const costoVal = Number(p.costo);
          if(!(precioVal>0) && (precioPub>0)){
            try{ ref.set({ precio: precioPub }, { merge:true }); } catch(_e){}
          } else if((precioVal>0) && (p).hasOwnProperty('precioPublico')){
            if(!(precioVal === costoVal)){
              try{ ref.set({ precioPublico: firebase.firestore.FieldValue.delete() }, { merge:true }); } catch(_e){}
            }
          }
          if((p).hasOwnProperty('caracteristicas')){
            try{ ref.set({ caracteristicas: firebase.firestore.FieldValue.delete() }, { merge:true }); } catch(_e){}
          }
          if((p).hasOwnProperty('mayoristasRev')){
            try{ ref.set({ mayoristasRev: firebase.firestore.FieldValue.delete() }, { merge:true }); } catch(_e){}
          }
          if(Object.prototype.hasOwnProperty.call(p,'existencias')){
            const t = typeof p.existencias;
            if(t !== 'number'){
              const fixed = Number(p.existencias) || 0;
              try{ ref.set({ existencias: fixed }, { merge:true }); } catch(_e){}
            }
          }
        });
      }catch(_e){}
  // (backfill removido) descripcionLower
      window.products = arr;
      if(window.AppState) window.AppState.productos = arr;
      try { document.dispatchEvent(new CustomEvent('productosUpdated', { detail: { total: arr.length } })); } catch(_e){}
  // (backfill removido) sincronización automática de categorías
  // One-time auto backfill: link products to categorias by name to ensure counts work without manual action
      if(!window.__prodCatBackfillScheduled){
        window.__prodCatBackfillScheduled = true;
        setTimeout(async ()=>{
          try{
            const need = (window.products||[]).some(p=> !p.categoriaId && (p.categoria||p.categoriaNombre));
    if(need && window.firebaseApi?.backfillProductosCategoriaId){
      // 0 => all products (no limit) in our implementation
      await window.firebaseApi.backfillProductosCategoriaId(0);
            }
          }catch(_e){}
        }, 1200);
      }
      // Fix de precios sospechosos (una sola vez)
      if(!window.__preciosFixScheduled){
        window.__preciosFixScheduled = true;
        setTimeout(async ()=>{
          try{
            const fixed = await window.firebaseApi?.diagnosticarPreciosSospechosos?.({ fix:true });
            if(Array.isArray(fixed) && fixed.length){ console.info(`[Precios][Fix] Reparados ${fixed.length} productos con precio sospechoso`); }
          }catch(e){ console.warn('Auto-fix precios sospechosos fallo', e); }
        }, 1200);
      }
    });
  }

  // Insumos
  const cIns = col(collectionsMap.insumos);
    if(cIns) {
    cIns.onSnapshot(snap=>{
      const arr = [];
      snap.forEach(doc=>{ arr.push({ _id: doc.id, ...doc.data() }); });
      window.supplies = arr;
      if(window.AppState) window.AppState.insumos = arr;
      if(typeof renderSuppliesTable === 'function') renderSuppliesTable();
    });
  }

  // Caja (movimientos históricos simples)
  const cCaja = col(collectionsMap.caja);
  if(cCaja){
    cCaja.orderBy('fecha','desc').limit(500).onSnapshot(snap=>{
      const fullArr = [];
      snap.forEach(doc=>{ fullArr.push({ _id: doc.id, ...doc.data() }); });
      // Ordenamiento estable (mismo que antes) sobre el arreglo completo
      try{
        fullArr.sort((a,b)=>{
          const fa = String(a.fecha||'');
          const fb = String(b.fecha||'');
          if(fa>fb) return -1; if(fa<fb) return 1;
          const ca = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : (a.createdAt? Number(a.createdAt): 0);
          const cb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : (b.createdAt? Number(b.createdAt): 0);
          if(cb!==ca) return cb - ca;
          const foa = Number(a.folio||0), fob = Number(b.folio||0);
          if(fob!==foa) return fob - foa;
          const gfA = String(a.gastoFolio||'');
          const gfB = String(b.gastoFolio||'');
          if(gfA || gfB){ const cmpGF = gfB.localeCompare(gfA); if(cmpGF!==0) return cmpGF; }
          const ifA = String(a.ingresoFolio||'');
          const ifB = String(b.ingresoFolio||'');
          if(ifA || ifB){ const cmpIF = ifB.localeCompare(ifA); if(cmpIF!==0) return cmpIF; }
            const rfA = String(a.retiroFolio||'');
            const rfB = String(b.retiroFolio||'');
            if(rfA || rfB){ const cmpRF = rfB.localeCompare(rfA); if(cmpRF!==0) return cmpRF; }
            const i8a = String(a.id8||'');
            const i8b = String(b.id8||'');
            if(i8a || i8b){ const cmp = i8b.localeCompare(i8a); if(cmp!==0) return cmp; }
          return String(b._id||'').localeCompare(String(a._id||''));
        });
      }catch(_e){}

      // Guardar histórico completo para administradores / toggle
      window._cajaAll = fullArr;

      // Bandera global para usar solo día actual
      let onlyToday = true; try { if(typeof window.__ONLY_TODAY_MODE__ !== 'undefined') onlyToday = !!window.__ONLY_TODAY_MODE__; } catch(_e){}
      function todayStrTZ(tz){
        try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
        catch(e){ return new Date().toISOString().slice(0,10); }
      }
      const tz = (window.__FECHA_TZ__ || 'America/Mexico_City');
      const todayStr = todayStrTZ(tz);
      const filtered = onlyToday ? fullArr.filter(r => r && r.fecha === todayStr) : fullArr;

      // Exponer movimientos filtrados (excluyendo marcados historico) a la UI
      window.cashRecords = filtered.filter(r=> !r.historico);
      window.historicalCashRecords = filtered; // versión visible (antes era full lista)
      if(window.AppState){ window.AppState.caja = filtered; }
      if(typeof renderCashTable === 'function') renderCashTable();
      try { document.dispatchEvent(new CustomEvent('cajaUpdated', { detail: { total: filtered.length, fecha: todayStr, soloHoy: onlyToday } })); } catch(_e){}
    });
  }

  // Clientes
  const cCli = col(collectionsMap.clientes);
  if(cCli){
    cCli.orderBy('nombre').limit(3000).onSnapshot(snap=>{
      const arr = [];
      snap.forEach(doc=>{ arr.push({ id: doc.id, _id: doc.id, ...doc.data() }); });
      window.clientes = arr;
      if(window.AppState) window.AppState.clientes = arr;
      if(typeof renderClientesTable === 'function') renderClientesTable();
      try { document.dispatchEvent(new CustomEvent('clientesUpdated', { detail: { total: arr.length } })); } catch(_e){}
  // (backfill removido) nombreLower y códigos de clientes
    });
  }

  const unidadesCol = col(collectionsMap.unidadesMedida);
  if(unidadesCol){
    unidadesCol.onSnapshot(snap=>{
      const list = [];
      snap.forEach(doc=>{
        const data = doc.data()||{};
        list.push({ id: doc.id, _docId: doc.id, ...data });
      });
      list.sort((a,b)=>{
        const famA = String(a.familia||'');
        const famB = String(b.familia||'');
        const famCmp = famA.localeCompare(famB, undefined, { sensitivity:'base' });
        if(famCmp !== 0) return famCmp;
        const abbrA = String(a.abreviatura||a.nombre||'');
        const abbrB = String(b.abreviatura||b.nombre||'');
        return abbrA.localeCompare(abbrB, undefined, { sensitivity:'base' });
      });
      window.unidadesMedida = list;
      if(window.AppState) window.AppState.unidadesMedida = list;
      try { document.dispatchEvent(new CustomEvent('unidadesMedida:updated', { detail: { total: list.length } })); }catch(_e){}
    });
  }

  const puntosMediosCol = col(collectionsMap.puntosMedios);
  if(puntosMediosCol){
    if(!Array.isArray(window.puntosMediosGlobal)) window.puntosMediosGlobal = [];
    puntosMediosCol.orderBy('ts','desc').limit(2000).onSnapshot(snap=>{
      const arr = [];
      snap.forEach(doc=>{ arr.push({ id: doc.id, ...doc.data() }); });
      window.puntosMediosGlobal = arr;
      try { document.dispatchEvent(new CustomEvent('puntosMediosUpdated', { detail: { total: arr.length } })); }
      catch(_e){}
    });
  }

  // Facturas
  const facCol = col(collectionsMap.facturas);
  if(facCol){
    facCol.orderBy('folio','desc').limit(500).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=>{ arr.push({ id: doc.id, _docId: doc.id, ...doc.data() }); });
      window.facturas = arr;
      if(typeof window.updateFacturasFromFirestore==='function') try { window.updateFacturasFromFirestore(arr); } catch(_e){}
    });
  }

  // Sucursales
  const sucsCol = col(collectionsMap.sucursales);
  if(sucsCol){
    sucsCol.orderBy('nombre').limit(500).onSnapshot(async snap=>{
      const arr=[]; snap.forEach(doc=>{ arr.push({ id: doc.id, _docId: doc.id, ...doc.data() }); });
      window.sucursales = arr;
      if(typeof window.updateSucursalesFromFirestore==='function') try { window.updateSucursalesFromFirestore(arr); } catch(_e){}
      // (backfill removido) códigos de sucursales
    });
  }

  // Cajas (catálogo fijo por sucursal)
  const cajasCol = col(collectionsMap.cajas);
  if(cajasCol){
    cajasCol.orderBy('nombreLower').onSnapshot(snap=>{
      try{ window.__cajasListenerReady = true; }catch(_e){}
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.cajas = arr;
      if(typeof window.updateCajasFromFirestore==='function'){
        try { window.updateCajasFromFirestore(arr); } catch(_e){}
      }
      try{ document.dispatchEvent(new Event('cajas:updated')); }catch(_e){}
    }, err=>{
      console.warn('[Firebase] Error escuchando coleccion_cajas:', err?.message||err);
      try{ window.__cajasListenerReady = true; }catch(_e){}
    });
  }

  // (backfill removido) programaciones globales

  // Proveedores (catálogo y saldo)
  const provCol = col(collectionsMap.proveedores);
  if(provCol){
    provCol.orderBy('nombreLower').limit(500).onSnapshot(async snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.proveedores = arr;
      if(typeof window.updateProveedoresFromFirestore==='function') try { window.updateProveedoresFromFirestore(arr); } catch(_e){}
  // (backfill removido) generación automática de códigos de proveedores
    });
  }

  // CXP Proveedores
  const cxpProvCol = col(collectionsMap.cxpProveedores);
  if(cxpProvCol){
    cxpProvCol.orderBy('nombreLower').limit(500).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.cxpProveedores = arr;
      if(typeof window.updateCxpProveedoresFromFirestore==='function'){
        try { window.updateCxpProveedoresFromFirestore(arr); } catch(_e){}
      }
      try { document.dispatchEvent(new CustomEvent('cxp_proveedores:updated', { detail: arr })); } catch(_e){}
    });
  }

  // Usuarios
  const usersCol = col(collectionsMap.usuarios);
  if(usersCol){
    usersCol.limit(1000).onSnapshot(async snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.usuarios = arr;
      if(typeof window.updateUsuariosFromFirestore==='function'){
        try { window.updateUsuariosFromFirestore(arr); } catch(_e){}
      }
      try { document.dispatchEvent(new CustomEvent('usuariosUpdated', { detail: { total: arr.length } })); } catch(_e){}
  // (backfill removido) generación automática de códigos de usuarios
    });
  }

  // Categorías de productos
  const catCol = col(collectionsMap.categorias);
  if(catCol){
    // Load all categorías to ensure counts and datalists include all
    catCol.orderBy('nombreLower').onSnapshot(async snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
  window.categorias = arr;
  if(typeof window.renderCategoriasTable==='function') try { window.renderCategoriasTable(); } catch(_e){}
  try{ document.dispatchEvent(new Event('categorias:updated')); }catch(_e){}
  // Opportunistic backfill: ensure 8+ digit codigo exists
      try{
        const toFix = arr.filter(c=> !(c.codigo && /^\d{8,}$/.test(String(c.codigo))));
        if(toFix.length){
          let batch = window.db.batch(); let ops=0;
          for(const c of toFix.slice(0,50)){
            const code = await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
            batch.set(catCol.doc(c.id), { codigo: code, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
            ops++; if(ops>=450){ await batch.commit().catch(()=>{}); batch = window.db.batch(); ops=0; }
          }
          if(ops>0) await batch.commit();
        }
      }catch(_e){}
  // (backfill removido) completar createdBy en categorías y sincronización automática desde productos
    });
  }

  // Categorías de gasto
  const gCatCol = col(collectionsMap.gastoCategorias);
  if(gCatCol){
    gCatCol.orderBy('descripcionLower').limit(1000).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.gastoCategorias = arr;
      if(typeof window.renderGastoCategoriasTable==='function'){
        try { window.renderGastoCategoriasTable(); } catch(_e){}
      }
      if(typeof window.populateExpenseCategoryOptions==='function'){
        try { window.populateExpenseCategoryOptions(); } catch(_e){}
      }
    });
  }

  // Pedidos proveedor
  const pedidosProvCol = col(collectionsMap.pedidosProveedor);
  if(pedidosProvCol){
    pedidosProvCol.orderBy('fechaCreacion','desc').limit(300).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.pedidosProveedor = arr;
      if(typeof window.updatePedidosProveedorFromFirestore==='function') try { window.updatePedidosProveedorFromFirestore(arr); } catch(_e){}
    });
  }

  // Pagos (complementos)
  const pagosCol = col(collectionsMap.pagos);
  if(pagosCol){
    pagosCol.orderBy('fecha','desc').limit(500).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.pagosListado = arr;
      if(typeof window.updatePagosFromFirestore==='function') try { window.updatePagosFromFirestore(arr); } catch(_e){}
    });
  }

  // Maquinas
  const maqCol = col(collectionsMap.maquinas);
  if(maqCol){
    maqCol.orderBy('nombre').limit(300).onSnapshot(snap=>{
      const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, _docId:doc.id, ...doc.data() }));
      window.maquinasState = arr;
      if(typeof window.updateMaquinasFromFirestore==='function') try { window.updateMaquinasFromFirestore(arr); } catch(_e){}
    });
  }

  // Ventas (listener principal para alimentar UI y CxC)
  const ventasCol = col('ventas');
  if(ventasCol){
    ventasCol.orderBy('fecha','desc').limit(1000).onSnapshot(snap=>{
      const fullArr = [];
      snap.forEach(doc=>{ fullArr.push({ id: doc.id, _id: doc.id, ...doc.data() }); });

      // Determinar rol del usuario actual (admin o no) y su uid
      let isAdmin = false; let uid = null;
      try {
        uid = window.auth?.currentUser?.uid || null;
        const us = Array.isArray(window.usuarios) ? window.usuarios : [];
        const me = uid ? us.find(x=> String(x.id||x._docId)===String(uid)) : null;
        const role = (me?.role || me?.perfil || '').toString().toLowerCase();
        isAdmin = role.includes('admin');
      } catch(_e) { isAdmin = false; }

      // Modo "solo día actual": oculta totalmente ventas de días anteriores para que la interfaz
      // amanezca en blanco (requisito: "que no se vean las ventas del día anterior ni nada relacionado").
      // Se puede desactivar asignando window.__ONLY_TODAY_MODE__ = false antes de inicializar firebase.
      let onlyToday = true; try { if(typeof window.__ONLY_TODAY_MODE__ !== 'undefined') onlyToday = !!window.__ONLY_TODAY_MODE__; } catch(_e){}

      // Obtener fecha de hoy en TZ México para compararla con campo 'fecha' (YYYY-MM-DD) de las ventas
      function todayStrTZ(tz){
        try {
          const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
          return fmt.format(new Date()); // en-CA -> YYYY-MM-DD
        } catch(e){ return new Date().toISOString().slice(0,10); }
      }
      const tz = (window.__FECHA_TZ__ || 'America/Mexico_City');
      const todayStr = todayStrTZ(tz);

      // Filtrar por día y, si no es admin, por autor (createdBy)
      const baseByDate = (onlyToday ? fullArr.filter(v => v && v.fecha === todayStr) : fullArr);
      let filtered;
      if(isAdmin){
        filtered = baseByDate;
      } else {
        // Si aún no hay uid (p.ej., en el primer tick tras cambiar de cuenta), no mostrar nada para evitar fugas
        filtered = uid ? baseByDate.filter(v => String(v?.createdBy||'') === String(uid)) : [];
      }

  // Guardar el arreglo completo solo para admin; para no-admin, filtrar por uid cuando esté disponible (o vacío si no)
  window._ventasAll = isAdmin ? fullArr : (uid ? fullArr.filter(v => String(v?.createdBy||'') === String(uid)) : []);

      // Exponer únicamente las ventas filtradas a la mayoría de la UI
      window.ventas = filtered;
      if(window.AppState) window.AppState.ventas = filtered;

      // Notificar a la UI dependiente (dashboard, historial, CxC, etc.) usando el total visible
      try { document.dispatchEvent(new CustomEvent('ventasUpdated', { detail: { total: filtered.length, fecha: todayStr, soloHoy: onlyToday } })); } catch(_e){}

      // Reconstruir CxC en memoria. Si soloHoy está activo queremos también mostrar "en blanco" CxC
      // (nada relacionado con días anteriores). Para no perder la info histórica dejamos opción configurable.
      // Si se quisiera conservar adeudos históricos aun ocultando ventas, se podría pasar fullArr en vez de filtered.
      try {
        if(typeof window.rebuildCxcFromVentas === 'function') {
          const prevForceAll = window.__CXC_USAR_HISTORICO__ === true; // bandera opcional para conservar adeudos
          const backup = window.ventas; // ventas visibles ahora
          if(prevForceAll){
            // Temporalmente usar todas para que CxC refleje adeudos históricos
            window.ventas = fullArr;
            window.rebuildCxcFromVentas();
            window.ventas = backup; // restaurar filtradas
          } else {
            // CxC se calcula sólo con las ventas visibles de hoy -> quedará en blanco al iniciar el día
            window.rebuildCxcFromVentas();
          }
        }
      } catch(_e){}
    });
  }
}

// --- Auth secundario (para crear usuarios sin afectar sesión actual) ---
function getSecondaryAuth(){
  try {
    if(!firebase) return null;
    if(!window._secondaryApp){
      // Reutiliza si ya existe una app con este nombre
      const existing = (firebase.apps||[]).find(a=> a && a.name==='__sec');
      window._secondaryApp = existing || firebase.initializeApp(firebaseConfig, '__sec');
    }
    return window._secondaryApp.auth();
  } catch(e){ console.warn('No se pudo inicializar Auth secundario', e); return null; }
}

// Utilidad opcional: limpieza manual de campos legacy en colección productos
window.cleanupLegacyProductoFields = async function cleanupLegacyProductoFields(batchSize = 400){
  if(!window.db){ console.warn('[Cleanup] Firestore no inicializado'); return; }
  const prodCol = col(collectionsMap.productos);
  if(!prodCol){ console.warn('[Cleanup] Colección productos no encontrada'); return; }
  let fixed = 0, scanned = 0;
  try {
    const snap = await prodCol.get();
    const updates = [];
    snap.forEach(doc=>{
      scanned++;
      const p = doc.data() || {};
      const patch = {};
      if(typeof p.precio !== 'number' && typeof p.precioPublico === 'number'){ patch.precio = p.precioPublico; }
      if((p).hasOwnProperty('precioPublico')){ patch.precioPublico = firebase.firestore.FieldValue.delete(); }
      if((p).hasOwnProperty('caracteristicas')){ patch.caracteristicas = firebase.firestore.FieldValue.delete(); }
      if((p).hasOwnProperty('mayoristasRev')){ patch.mayoristasRev = firebase.firestore.FieldValue.delete(); }
      if(Object.keys(patch).length){ updates.push({ id: doc.id, patch }); }
    });
    console.log(`[Cleanup] Revisados ${scanned} productos; con cambios: ${updates.length}`);
    // Aplicar en lotes para evitar límites
    while(updates.length){
      const chunk = updates.splice(0, batchSize);
      const batch = window.db.batch();
      chunk.forEach(u=>{ batch.set(prodCol.doc(u.id), u.patch, { merge:true }); });
      await batch.commit();
      fixed += chunk.length;
      console.log(`[Cleanup] Aplicado batch; acumulado ${fixed}`);
    }
    console.log(`[Cleanup] Completado. Total documentos actualizados: ${fixed}`);
  } catch(e){ console.error('[Cleanup] Error', e); }
};

// --- Utilidades: Código interno único de 8+ dígitos ---
function random8Digits(){
  // Usa crypto si está disponible para mejor entropía
  try {
    const a = new Uint8Array(4);
    if(window.crypto?.getRandomValues){ window.crypto.getRandomValues(a); }
    else { for(let i=0;i<4;i++) a[i] = (Math.random()*256)|0; }
    // Genera un número de 8 dígitos (10000000..99999999) a partir de 32 bits
    const n = (a[0]<<24) | (a[1]<<16) | (a[2]<<8) | a[3];
    const abs = Math.abs(n);
    return String(10000000 + (abs % 90000000));
  } catch(_e){
    return String(Math.floor(10000000 + Math.random()*90000000));
  }
}
// Random numeric string with given width (>=1). First digit non-zero.
function randomDigits(width=8){
  if(width<=1) return String(1 + Math.floor(Math.random()*9));
  let first = 1 + Math.floor(Math.random()*9);
  let rest = '';
  try{
    const len = width - 1;
    const bytes = new Uint8Array(len);
    if(window.crypto?.getRandomValues){ window.crypto.getRandomValues(bytes); }
    else { for(let i=0;i<len;i++) bytes[i] = (Math.random()*256)|0; }
    for(let i=0;i<len;i++) rest += String(bytes[i] % 10);
  }catch(_e){
    for(let i=0;i<width-1;i++) rest += String(Math.floor(Math.random()*10));
  }
  return String(first) + rest;
}

// Check if a code exists across system collections (categorias.codigo, productos.codigoInterno, clientes/sucursales/proveedores/usuarios.codigo)
async function codeExistsAcrossSystem(code){
  const checks = [
    { col: collectionsMap.categorias, field: 'codigo' },
    { col: collectionsMap.productos, field: 'codigoInterno' },
    { col: collectionsMap.clientes, field: 'codigo' },
    { col: collectionsMap.sucursales, field: 'codigo' },
    { col: collectionsMap.proveedores, field: 'codigo' },
    { col: collectionsMap.usuarios, field: 'codigo' },
  ];
  try{
    const results = await Promise.all(checks.map(async c=>{
      try{
        const q = await col(c.col).where(c.field,'==', code).limit(1).get();
        return !q.empty;
      }catch(_e){ return false; }
    }));
    return results.some(Boolean);
  }catch(_e){ return false; }
}

// Tx variant using transaction.get on queries
async function codeExistsAcrossSystemTx(tx, code){
  const checks = [
    { col: collectionsMap.categorias, field: 'codigo' },
  { col: collectionsMap.gastoCategorias, field: 'codigo' },
    { col: collectionsMap.productos, field: 'codigoInterno' },
    { col: collectionsMap.clientes, field: 'codigo' },
    { col: collectionsMap.sucursales, field: 'codigo' },
    { col: collectionsMap.proveedores, field: 'codigo' },
    { col: collectionsMap.usuarios, field: 'codigo' },
  ];
  try{
    const results = await Promise.all(checks.map(async c=>{
      try{
        const q = await tx.get(col(c.col).where(c.field,'==', code).limit(1));
        return !q.empty;
      }catch(_e){ return false; }
    }));
    return results.some(Boolean);
  }catch(_e){ return false; }
}

// Generate a globally-unique numeric code, starting at minWidth and increasing width if necessary
async function generateUniqueGlobalCodigo({ minWidth=8, maxWidth=12, attemptsPerWidth=30 }={}){
  let width = Math.max(8, minWidth|0);
  while(width <= maxWidth){
    for(let i=0;i<attemptsPerWidth;i++){
      const candidate = randomDigits(width);
      const exists = await codeExistsAcrossSystem(candidate);
      if(!exists) return candidate;
    }
    width++;
  }
  // As último recurso, return timestamp-based random with width+1
  const fallback = String(Date.now()) + String(Math.floor(Math.random()*10));
  return fallback;
}

// Nota: evitamos variante transaccional porque tx.get en queries puede causar errores en cliente.

/** Genera/valida un código de 8 dígitos único dentro de la colección de productos (sin usar colección auxiliar). */
async function getUniqueCodigoInterno(preferred=''){
  const code = String(preferred||'').trim();
  if(code){
    if(!/^\d{8,}$/.test(code)) throw new Error('codigoInterno debe tener al menos 8 dígitos');
    // Debe ser único en productos y también globalmente
    const q = await col(collectionsMap.productos).where('codigoInterno','==', code).limit(1).get();
    if(q.empty){
      const existsGlobal = await codeExistsAcrossSystem(code);
      if(!existsGlobal) return code;
    }
    throw new Error('Código preferido ya está en uso');
  }
  return await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
}

// Incrementa un contador dentro de una transacción y devuelve el siguiente valor
async function nextCounterTx(tx, key, startAt=0){
  const ref = col(collectionsMap.counters).doc(String(key));
  const doc = await tx.get(ref);
  let nextVal;
  if(doc.exists){
    const curr = Number(doc.data().value)||0;
    nextVal = curr + 1;
    // Update existing doc
    tx.update(ref, { value: nextVal, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  } else {
    // Create new doc when it doesn't exist to avoid precondition errors
    nextVal = startAt + 1;
    tx.set(ref, { value: nextVal, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
  return nextVal;
}

function padDynamic(num, minWidth=8){
  const s = String(num);
  return s.length < minWidth ? s.padStart(minWidth,'0') : s;
}

// Genera un valor único basado en counter con verificación de duplicado (no-tx)
async function generateUniqueByCounter({ counterKey, startAt=0, colName, field, minWidth=8, maxAttempts=8 }){
  const c = col(colName);
  for(let i=0;i<maxAttempts;i++){
    const n = await window.firebaseApi.nextCounter(counterKey, startAt);
    const val = padDynamic(n, minWidth);
    try{
      if(c && field){
        const q = await c.where(field,'==', val).limit(1).get();
        if(q.empty) return val;
      } else {
        return val;
      }
    }catch(_e){ return val; }
  }
  // fallback sin check si excede reintentos
  const n = await window.firebaseApi.nextCounter(counterKey, startAt);
  return padDynamic(n, minWidth);
}

// Genera un valor único basado en counter con verificación de duplicado (tx)
async function generateUniqueByCounterTx(tx, { counterKey, startAt=0, colName, field, minWidth=8, maxAttempts=8 }){
  const c = col(colName);
  for(let i=0;i<maxAttempts;i++){
    const n = await nextCounterTx(tx, counterKey, startAt);
    const val = padDynamic(n, minWidth);
    try{
      if(c && field){
        const q = await tx.get(c.where(field,'==', val).limit(1));
        if(q.empty) return val;
      } else {
        return val;
      }
    }catch(_e){ return val; }
  }
  // último intento
  const n2 = await nextCounterTx(tx, counterKey, startAt);
  return padDynamic(n2, minWidth);
}

// --- API CRUD mínima ---
window.firebaseApi = {
  // Turnos de caja
  /**
   * Abre un turno de caja.
   * @param {Object} opts
   * @param {?number} opts.efectivoInicial  Monto inicial contado (float) si el usuario ya lo ingresó.
   * @param {?string} opts.nota  Nota libre / observaciones de apertura.
   * @param {?string} opts.dispositivo  Identificador de dispositivo / estación.
   * @returns {Promise<string>} turnoId
   */
  async openTurno(opts={}){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const uid = window.auth?.currentUser?.uid || null;
    if(!uid) throw new Error('No hay usuario');
    const users = Array.isArray(window.usuarios)? window.usuarios : [];
    const me = users.find(u=> String(u.id||u.uid)===String(uid));
    const cajaId = me?.cajaId || null;
    const caja = me?.caja || null;
    const sucursal = me?.sucursal || null;
    const tz = __TURNOS_CFG__.tz || window.__CORTE_TZ__ || 'America/Mexico_City';
    const now = new Date();
    const fecha = new Intl.DateTimeFormat('en-CA',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
    // Turno planificado por hora de apertura
    const minNow = minutesSinceMidnight(now, tz);
    const pmStartMin = parseHhmmToMinutes(__TURNOS_CFG__.pmStart)||900;
    const turnoPlanificado = minNow >= pmStartMin ? 'PM' : 'AM';
    // Folio secuencial diario (por caja si existe)
    let folioTurno = null;
    try{
      const counterKey = `turnoSeq-${cajaId||'GEN'}-${fecha}`; // independiente por día y caja
      const seq = await window.firebaseApi.nextCounter(counterKey, 0);
      const seqStr = String(seq).padStart(3,'0');
      folioTurno = `T-${(cajaId||'GEN')}-${fecha.replace(/-/g,'')}-${seqStr}`;
    }catch(_e){ /* silencioso */ }
    const ref = col(collectionsMap.cajaTurnos).doc();
    const payload = deepClean({
      cajaId: cajaId||null, caja: caja||null, sucursal: sucursal||null,
      userId: uid, usuario: (me?.nombre||me?.displayName||me?.email||null),
      fecha, abiertoEn: firebase.firestore.FieldValue.serverTimestamp(), abiertoTz: tz,
      estatus: 'abierto',
      jornada: fecha,
      turnoPlanificado,
      folio: folioTurno,
      efectivoInicial: (opts.efectivoInicial!=null? Number(opts.efectivoInicial): null),
      efectivoInicialFuente: (opts.efectivoInicial!=null? 'usuario': null),
      aperturaNota: opts.nota || null,
      aperturaDispositivo: opts.dispositivo || (window.__HOSTNAME__||null),
      abiertoEnApproxMs: Date.now(),
      version: 2
    });
    await ref.set(payload);
    window.currentTurnoId = ref.id;
    try{ window.__lastTurnoOpen = { id: ref.id, abiertoEnApproxMs: payload.abiertoEnApproxMs, fecha, userId: uid, cajaId, sucursal }; }catch(_e){}
    return ref.id;
  },
  /**
   * Cierra un turno abierto agregando datos de corte y diferencias.
   * @param {Object} opts
   * @param {?number} opts.efectivo  Efectivo contado al cierre.
   * @param {?string} opts.corteId   ID del documento de corte vinculado.
   * @param {?number} opts.expected  Efectivo esperado (según sistema) al momento del cierre.
   * @param {?number} opts.difference Diferencia (contado - esperado).
   * @param {?Object} opts.resumen   Resumen breakdown (ventasEfectivo, gastosEfectivo, etc.).
   * @param {?string} opts.modo      Modo de cierre (manual, auto-tras-corte, forzado, timeout, etc.).
   * @param {?string} opts.dispositivo Identificador de dispositivo de cierre.
   */
  async closeTurno({ efectivo=null, corteId=null, expected=null, difference=null, resumen=null, modo='auto-tras-corte', dispositivo=null }={}){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const turnoId = window.currentTurnoId || null;
    if(!turnoId) throw new Error('No hay turno abierto');
    const tz = __TURNOS_CFG__.tz || window.__CORTE_TZ__ || 'America/Mexico_City';
    // Leer apertura para calcular duración y clasificación
    let abiertoAt = null;
    try{
      const snap = await col(collectionsMap.cajaTurnos).doc(String(turnoId)).get();
      if(snap.exists){
        const d = snap.data()||{};
        // serverTimestamp no está disponible en cliente; usar createdAt surrogate si existe
        // Fallback: si no hay timestamp, usar ahora menos 1 minuto
        abiertoAt = (d.abiertoEn && d.abiertoEn.toDate && d.abiertoEn.toDate()) || null;
      }
    }catch(_e){}
    const closeDate = new Date();
    const openDate = abiertoAt || new Date(closeDate.getTime() - 60*1000);
    const cls = classifyTurnoInterval(openDate, closeDate, __TURNOS_CFG__);
    const ref = col(collectionsMap.cajaTurnos).doc(String(turnoId));
    await ref.set(deepClean({
      cerradoEn: firebase.firestore.FieldValue.serverTimestamp(), cerradoTz: tz,
      efectivoCierre: (efectivo!=null? Number(efectivo): undefined),
      esperadoCierre: (expected!=null? Number(expected): undefined),
      diferenciaEfectivo: (difference!=null? Number(difference): undefined),
      resumenCierre: resumen || undefined,
      corteId: corteId || undefined,
      cierreModo: modo || 'manual',
      cierreDispositivo: dispositivo || (window.__HOSTNAME__||null),
      estatus:'cerrado',
      turnoTipo: cls.tipo,
      jornada: cls.jornada,
      durationMin: cls.durationMin,
      segments: cls.segments,
      version: 2
    }), { merge:true });
    window.currentTurnoId = null;
  },
  /** Establece (una sola vez) el efectivo inicial si no se definió al abrir. */
  async setTurnoEfectivoInicial(monto){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    let turnoId = window.currentTurnoId || null;
    if(!turnoId && typeof this.getTurnoAbierto==='function'){
      const t = await this.getTurnoAbierto();
      turnoId = t?.id || null;
    }
    if(!turnoId) throw new Error('No hay turno abierto');
    const ref = col(collectionsMap.cajaTurnos).doc(String(turnoId));
    const snap = await ref.get();
    if(snap.exists){
      const d = snap.data()||{};
      if(d.efectivoInicial!=null) return false; // ya seteado
    }
    await ref.set({ efectivoInicial: Number(monto), efectivoInicialFuente: 'usuario-ajuste' }, { merge:true });
    return true;
  },
  async getTurnoAbierto(){
    if(!window._firebaseReady) return null;
    const uid = window.auth?.currentUser?.uid || null;
    if(!uid) return null;
    const q = await col(collectionsMap.cajaTurnos).where('userId','==', uid).where('estatus','==','abierto').orderBy('abiertoEn','desc').limit(1).get();
    const doc = q.docs[0];
    if(doc){
      window.currentTurnoId = doc.id;
      try{
        const d = doc.data()||{};
        let approx = d.abiertoEnApproxMs || null;
        if(!approx && d.abiertoEn && d.abiertoEn.toDate) approx = d.abiertoEn.toDate().getTime();
        window.__lastTurnoOpen = { id: doc.id, abiertoEnApproxMs: approx, fecha: d.fecha, userId: d.userId, cajaId: d.cajaId, sucursal: d.sucursal };
      }catch(_e){}
      return { id: doc.id, ...doc.data() };
    }
    return null;
  },
  // =====================
  // Utilidades de contadores
  // =====================
  /** Devuelve un ID de 8 dígitos creciente e irrepetible para movimientos de caja. */
  async getNextCajaId8(){
  // Auto-expande más allá de 8 dígitos si se supera el rango
  const val = await generateUniqueByCounter({ counterKey:'cajaId8', startAt:9999999, colName: collectionsMap.caja, field:'id8', minWidth:8 });
  return val;
  },
  /** Versión transaccional de ID 8 dígitos dentro de tx. */
  async getNextCajaId8Tx(tx){
  const val = await generateUniqueByCounterTx(tx, { counterKey:'cajaId8', startAt:9999999, colName: collectionsMap.caja, field:'id8', minWidth:8 });
  return val;
  },
  /** Obtiene un número de categoría único verificando contra la colección, evitando colisiones antiguas. */
  async getUniqueCategoriaNumero(maxAttempts=12){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const catCol = col(collectionsMap.categorias);
    for(let i=0;i<maxAttempts;i++){
      const n = await window.firebaseApi.nextCounter('categoriaNumero', 0);
      try{
        const q = await catCol.where('numero','==', n).limit(1).get();
        if(q.empty) return n;
      }catch(_e){ /* en caso de fallo de red, reintentar */ }
    }
    throw new Error('No se pudo asignar un número de categoría único');
  },
  /** Versión transaccional para creación dentro de tx. */
  async getUniqueCategoriaNumeroTx(tx, _maxAttempts=12){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    // Dentro de una transacción cliente, evitar consultas por query; el contador garantiza unicidad.
    const n = await nextCounterTx(tx, 'categoriaNumero', 0);
    return n;
  },
  async peekNextCounter(key, startAt=0){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const ref = col(collectionsMap.counters).doc(String(key));
    const snap = await ref.get();
    if(!snap.exists){ return (startAt + 1); }
    const val = Number(snap.data().value)||0;
    return val + 1;
  },
  async nextCounter(key, startAt=0){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const ref = col(collectionsMap.counters).doc(String(key));
    const result = await window.db.runTransaction(async tx =>{
      const doc = await tx.get(ref);
      if(doc.exists){
        const curr = Number(doc.data().value)||0;
        const nextVal = curr + 1;
        tx.update(ref, { value: nextVal, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        return nextVal;
      } else {
        const nextVal = startAt + 1;
        tx.set(ref, { value: nextVal, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        return nextVal;
      }
    });
    return result;
  },
  // Productos
  async addProducto(data){
    if(!window._firebaseReady){ console.warn('[addProducto] Firebase no listo'); throw new Error('Firebase no inicializado'); }
  // Limpia profundamente valores undefined en objetos/arreglos anidados
  const payload = deepClean({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  // Validación fuerte: descripción requerida
  const desc = String(payload.descripcion||'').trim();
  if(!desc){ throw new Error('Producto inválido: descripción requerida'); }
    if(payload.descripcion && !payload.descripcionLower){ payload.descripcionLower = String(payload.descripcion).trim().toLowerCase(); }
  if(Array.isArray(payload.variantes) && payload.variantes.length){
    const totalVarExist = payload.variantes.reduce((sum, v)=> sum + (Number(v.existencias||0)||0), 0);
    if(Number.isFinite(totalVarExist)) payload.existencias = Number(totalVarExist||0);
  }
  // Redundante por seguridad (deepClean ya elimina undefined)
  Object.keys(payload).forEach(k=>{ if(payload[k] === undefined) delete payload[k]; });
    try {
  const ref = col(collectionsMap.productos).doc();
      // Generar/validar código único dentro de productos
      const code = await getUniqueCodigoInterno(payload.codigoInterno ? String(payload.codigoInterno) : '');
      // Upsert de categoría si viene nombre libre (no transaccional)
      let categoriaRefId = null;
      const catName = (payload.categoria||'').trim();
  if(catName){
        const catNorm = catName.toLowerCase();
        const catCol = col(collectionsMap.categorias);
        if(catCol){
          const q = await catCol.where('nombreLower','==', catNorm).limit(1).get();
          if(!q.empty){ categoriaRefId = q.docs[0].id; }
          else {
            // Use central helper to create category with proper codigo/numero handling
            try{ categoriaRefId = await window.firebaseApi.addCategoria(catName); }
            catch(_e){
              // Race fallback: another client may have created it; re-query
              try{
                const q2 = await catCol.where('nombreLower','==', catNorm).limit(1).get();
                if(!q2.empty){ categoriaRefId = q2.docs[0].id; }
              }catch(__e){}
            }
          }
        }
      }
      const toSet = { ...payload, codigoInterno: code, categoriaId: categoriaRefId||null };
      await ref.set(toSet);
      console.log('[Firebase][addProducto] OK id=', ref.id, 'payload=', { ...payload, codigoInterno: '(asignado)' });
      return ref.id;
    } catch(e){
      console.error('[Firebase][addProducto] ERROR', e);
      throw e;
    }
  },
  /** Backfill: asigna descripcionLower a productos que no lo tengan. */
  async backfillProductosDescripcionLower(limit=0){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const prodCol = col(collectionsMap.productos);
    let query = limit > 0 ? prodCol.limit(limit) : prodCol;
    const snap = await query.get();
    if(snap.empty){
      console.log('[Backfill] No hay productos para procesar.');
      return { checked: 0, updated: 0 };
    }
    const norm = (s) => {
      try {
        // Lógica idéntica a la de script.js para consistencia
        return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
      } catch (e) {
        return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      }
    };
    let updated = 0;
    let batch = window.db.batch();
    let ops = 0;
    for(const doc of snap.docs){
      const p = doc.data()||{};
      const desc = String(p.descripcion||'').trim();
      const currentLower = p.descripcionLower;
      const expectedLower = norm(desc);
      if(desc && currentLower !== expectedLower){
        batch.update(doc.ref, { descripcionLower: expectedLower });
        ops++; updated++;
        if(ops >= 450){ await batch.commit(); console.log(`[Backfill] Lote de ${ops} productos actualizado.`); batch = window.db.batch(); ops = 0; }
      }
    }
    if(ops > 0){ await batch.commit(); console.log(`[Backfill] Lote final de ${ops} productos actualizado.`); }
    notify(`Backfill completado. ${updated} productos actualizados de ${snap.size} revisados.`, 'ok');
    return { checked: snap.size, updated };
  },
  async updateProducto(id,data){
    if(!window._firebaseReady){ console.warn('[updateProducto] Firebase no listo'); throw new Error('Firebase no inicializado'); }
    try {
  // Limpia profundamente para evitar undefined en campos anidados (arrays/objetos)
  let patch = deepClean({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      // Validación fuerte en updates: si viene descripción, no permitir vacío
      if(Object.prototype.hasOwnProperty.call(patch,'descripcion')){
        const d = String(patch.descripcion||'').trim();
        if(!d){ throw new Error('Actualización inválida: descripción no puede ser vacía'); }
      }
      if(patch.descripcion && !patch.descripcionLower){ patch.descripcionLower = String(patch.descripcion).trim().toLowerCase(); }
      // Redundante por seguridad (deepClean ya elimina undefined)
      Object.keys(patch).forEach(k=>{ if(patch[k] === undefined) delete patch[k]; });
      const prodRef = col(collectionsMap.productos).doc(id);
      // Si cambia codigoInterno, validar contra productos y actualizar
      if(patch.codigoInterno != null){
        const next = String(patch.codigoInterno);
        if(!/^\d{8,}$/.test(next)) throw new Error('codigoInterno debe tener al menos 8 dígitos');
        // Conflicto en productos (excepto el mismo id)
        const q = await col(collectionsMap.productos).where('codigoInterno','==', next).limit(1).get();
        if(!q.empty){
          const found = q.docs[0];
          if(found.id !== id) throw new Error('Código interno ya en uso');
        }
        // No permitir colisión con códigos globales de otras colecciones
        const conflictElsewhere = await (async()=>{
          const checks = [
            { col: collectionsMap.categorias, field: 'codigo' },
            { col: collectionsMap.clientes, field: 'codigo' },
            { col: collectionsMap.sucursales, field: 'codigo' },
            { col: collectionsMap.proveedores, field: 'codigo' },
            { col: collectionsMap.usuarios, field: 'codigo' },
          ];
          for(const c of checks){
            try{ const qq = await col(c.col).where(c.field,'==', next).limit(1).get(); if(!qq.empty) return true; }catch(_e){}
          }
          return false;
        })();
        if(conflictElsewhere) throw new Error('Código interno en uso en otra entidad');
        await prodRef.update(patch);
      } else {
        // Si viene una categoría por nombre que no existe aún, upsert y enlazar categoriaId
        if(patch.categoria){
          const catName = String(patch.categoria||'').trim();
          if(catName){
            const catCol = col(collectionsMap.categorias);
            const catNorm = catName.toLowerCase();
            if(catCol){
              // Pre-checar fuera de tx
              let categoriaRefId = null;
              try{
                const q = await catCol.where('nombreLower','==', catNorm).limit(1).get();
                if(!q.empty){ categoriaRefId = q.docs[0].id; }
              }catch(_e){}
              if(!categoriaRefId){
                // Crear con API existente para manejar código y número
                try{ categoriaRefId = await window.firebaseApi.addCategoria(catName); }
                catch(_e){ /* si falla por condición de carrera, reintentar lectura */
                  try{
                    const q2 = await catCol.where('nombreLower','==', catNorm).limit(1).get();
                    if(!q2.empty){ categoriaRefId = q2.docs[0].id; }
                  }catch(__e){}
                }
              }
              const txPatch = deepClean({ ...patch, categoriaId: categoriaRefId||null });
              await prodRef.update(txPatch);
              return;
            }
          }
        }
        await prodRef.update(patch);
      }
      console.log('[Firebase][updateProducto] OK id=', id, 'patch=', data);
    } catch(e){
      console.error('[Firebase][updateProducto] ERROR id=', id, e);
      throw e;
    }
  },
  // =====================
  // Categorías (catálogo)
  // =====================
  async addCategoria(nombre){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const n = String(nombre||'').trim(); if(!n) throw new Error('Nombre requerido');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
    const catCol = col(collectionsMap.categorias);
    const norm = n.toLowerCase();
    // Idempotencia: revisar fuera de tx por nombreLower
    try{
      const exist = await catCol.where('nombreLower','==', norm).limit(1).get();
      if(!exist.empty){ return exist.docs[0].id; }
    }catch(_e){}
    // Generar código global único fuera de la tx (solo lecturas)
    const codigo = await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
    // Crear con contador dentro de tx sin consultas por query
    const newId = await window.db.runTransaction(async(tx)=>{
      // Re-validar idempotencia con lectura directa por nombreLower no es posible sin índice; si otro creó en paralelo, dejamos que set falle por duplicado lógico aceptable.
      const ref = catCol.doc();
      const numero = await window.firebaseApi.getUniqueCategoriaNumeroTx(tx);
      tx.set(ref, { nombre:n, nombreLower:norm, numero, codigo, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: uid });
      return ref.id;
    });
    return newId;
  },
  async updateCategoria(id, nombre){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const n = String(nombre||'').trim(); if(!n) throw new Error('Nombre requerido');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
    await col(collectionsMap.categorias).doc(id).set({ nombre:n, nombreLower:n.toLowerCase(), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge:true });
  },
  /** Generic patch for categorías (e.g., estatus='Inactiva') */
  async updateCategoriaFields(id, patch){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
    const data = { ...deepClean(patch), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid };
    await col(collectionsMap.categorias).doc(id).set(data, { merge:true });
    auditLog && auditLog('update','categoria', id, Object.keys(patch));
  },
  async deleteCategoria(id){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
  const uid = window.auth?.currentUser?.uid || null;
  await col(collectionsMap.categorias).doc(id).set({ estatus: 'Inactiva', updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge:true });
  auditLog && auditLog('disable','categoria', id, { estatus:'Inactiva' });
  },
  /** Desasigna todos los productos que tengan la categoriaId dada. Devuelve cuántos actualizó. */
  async unassignProductosFromCategoria(categoriaId){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const pid = String(categoriaId||''); if(!pid) return 0;
    const uid = window.auth?.currentUser?.uid || null;
    const prodCol = col(collectionsMap.productos);
    // Buscar productos por igualdad de categoriaId
    let snap;
    try{
      snap = await prodCol.where('categoriaId','==', pid).get();
    }catch(e){ console.warn('[Categorias] No se pudo consultar productos por categoriaId', e?.message||e); return 0; }
    if(snap.empty) return 0;
    let count = 0;
    let batch = window.db.batch();
    let ops = 0;
    snap.forEach(doc=>{
      // Limpia tanto la referencia (categoriaId) como los campos de texto legacy
      batch.set(
        prodCol.doc(doc.id),
        {
          categoriaId: null,
          categoria: null,
          categoriaNombre: null,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: uid
        },
        { merge:true }
      );
      count++; ops++;
      if(ops>=450){ batch.commit().catch(()=>{}); batch = window.db.batch(); ops=0; }
    });
    if(ops>0){ await batch.commit(); }
    try{ if(typeof window.renderProductosTable==='function') window.renderProductosTable(); }catch(_e){}
    return count;
  },
  /** Backfill: asigna código 8 dígitos a categorías que no lo tengan. Devuelve cuántas actualizó. */
  async backfillCategoriaCodigo8(limit=300){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const catCol = col(collectionsMap.categorias);
    const snap = await catCol.limit(limit).get();
    let updated = 0;
    for(const doc of snap.docs){
      const d = doc.data()||{};
      if(d.codigo && /^\d{8,}$/.test(String(d.codigo))) continue;
      try{
        const codigo = await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
        await catCol.doc(doc.id).set({ codigo, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        updated++;
      }catch(e){ console.warn('[Categorias][backfillCodigo8] fallo en', doc.id, e?.message||e); }
    }
    return updated;
  },
  /** Backfill: asigna categoriaId a productos legacy usando coincidencia por nombre (nombreLower).
   * Si limit=0 o <0, procesa todos los productos. Devuelve cuántos vinculó.
   */
  async backfillProductosCategoriaId(limit=800){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const prodCol = col(collectionsMap.productos);
    const catCol = col(collectionsMap.categorias);
    // Construir mapa nombreLower normalizado (sin acentos, espacios colapsados) -> id
    const catSnap = await catCol.get();
    const nameToId = new Map();
    const norm = (s)=> String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
    catSnap.forEach(doc=>{ const d=doc.data()||{}; const k = norm(d.nombreLower||d.nombre||''); if(k) nameToId.set(k, doc.id); });
    // Traer productos sin categoriaId pero con categoria/categoriaNombre texto
    const processBatch = async (snap)=>{
      let updated=0, ops=0; let batch = window.db.batch();
      for(const doc of snap.docs){
        const p = doc.data()||{};
        if(p.categoriaId) continue;
        const nm = norm(p.categoria||p.categoriaNombre||'');
        if(!nm) continue;
        const cid = nameToId.get(nm); if(!cid) continue;
        batch.set(prodCol.doc(doc.id), { categoriaId: cid, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        updated++; ops++;
        if(ops>=450){ await batch.commit().catch(()=>{}); batch = window.db.batch(); ops=0; }
      }
      if(ops>0) await batch.commit();
      return updated;
    };
    let totalUpdated = 0;
    if(!limit || limit<=0){
      // Process all documents paginated
      let last = null; let page = 0; const pageSize = 500;
      while(true){
        let q = prodCol.orderBy(firebase.firestore.FieldPath.documentId()).startAfter(last||'').limit(pageSize);
        if(!last) q = prodCol.orderBy(firebase.firestore.FieldPath.documentId()).limit(pageSize);
        const snap = await q.get();
        if(snap.empty) break;
        totalUpdated += await processBatch(snap);
        last = snap.docs[snap.docs.length-1].id; page++;
        if(page>2000) break; // safety
      }
    } else {
      const snap = await prodCol.limit(limit).get();
      totalUpdated += await processBatch(snap);
    }
  try{ document.dispatchEvent(new CustomEvent('productosUpdated', { detail:{ backfilled: totalUpdated } })); }catch(_e){}
  return totalUpdated;
  },
  // ==============================
  // Unidades de medida (catálogo)
  // ==============================
  async addUnidadMedida(data){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const unidadesCol = col(collectionsMap.unidadesMedida);
    if(!unidadesCol) throw new Error('Colección unidades no disponible');
    const nombre = normalizeUnidadTexto(data?.nombre);
    if(!nombre) throw new Error('El nombre es obligatorio');
    const abreviatura = normalizeUnidadTexto(data?.abreviatura);
    if(!abreviatura) throw new Error('La abreviatura es obligatoria');
    const familia = normalizeUnidadTexto(data?.familia);
    if(!familia) throw new Error('La familia es obligatoria');
    const familiaNorm = normalizeUnidadFamiliaKey(familia);
    const esBase = data?.esBase === true;
    const uid = window.auth?.currentUser?.uid || null;
    let factor = esBase ? 1 : parseUnidadFactor(data?.factor ?? data?.factorReferencia ?? data?.ratio ?? data?.ratioToBase);
    let baseUnidadId = esBase ? null : normalizeUnidadTexto(data?.baseUnidadId || '');
    if(!esBase){
      if(!baseUnidadId) throw new Error('Selecciona la unidad base de referencia');
      const baseSnap = await unidadesCol.doc(baseUnidadId).get();
      if(!baseSnap.exists) throw new Error('La unidad base seleccionada no existe');
      const baseData = baseSnap.data()||{};
      if(baseData.esBase !== true) throw new Error('La unidad de referencia debe estar marcada como base');
      const baseFamilia = baseData.familiaNorm || normalizeUnidadFamiliaKey(baseData.familia || baseData.familiaLower || '');
      if(baseFamilia && baseFamilia !== familiaNorm) throw new Error('La unidad base pertenece a otra familia');
      if(factor == null) throw new Error('El factor de conversión debe ser mayor a 0');
      if(baseUnidadId === '__self__') baseUnidadId = '';
    } else {
      baseUnidadId = null;
      factor = 1;
      const conflictSnap = await unidadesCol.where('familiaNorm','==', familiaNorm).limit(10).get();
      const baseExists = conflictSnap.docs.some(doc=> (doc.data()?.esBase === true));
      if(baseExists) throw new Error('Ya existe una unidad base en esta familia');
    }
    if(!esBase && baseUnidadId){
      if(baseUnidadId === data?.id) throw new Error('La unidad no puede referenciarse a sí misma');
    }
    const notas = normalizeUnidadTexto(data?.notas||'');
    const estatus = String(data?.estatus || 'Activa').trim() || 'Activa';
    const payload = deepClean({
      nombre,
      nombreLower: nombre.toLowerCase(),
      abreviatura,
      abreviaturaLower: abreviatura.toLowerCase(),
      familia,
      familiaLower: familiaNorm,
      familiaNorm,
      esBase,
      baseUnidadId: esBase ? null : (baseUnidadId || null),
      factor: esBase ? 1 : factor,
      factorReferencia: esBase ? 1 : factor,
      ratioToBase: esBase ? 1 : factor,
      notas: notas || undefined,
      estatus,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid
    });
    const ref = unidadesCol.doc();
    await ref.set(payload);
    return ref.id;
  },
  async updateUnidadMedida(id, patch){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const unidadesCol = col(collectionsMap.unidadesMedida);
    if(!unidadesCol) throw new Error('Colección unidades no disponible');
    const unitId = String(id||'').trim();
    if(!unitId) throw new Error('ID requerido');
    const ref = unidadesCol.doc(unitId);
    const snap = await ref.get();
    if(!snap.exists) throw new Error('Unidad no encontrada');
    const current = snap.data()||{};
    const uid = window.auth?.currentUser?.uid || null;
    const nombre = Object.prototype.hasOwnProperty.call(patch,'nombre') ? normalizeUnidadTexto(patch.nombre) : normalizeUnidadTexto(current.nombre);
    if(!nombre) throw new Error('El nombre es obligatorio');
    const abreviatura = Object.prototype.hasOwnProperty.call(patch,'abreviatura') ? normalizeUnidadTexto(patch.abreviatura) : normalizeUnidadTexto(current.abreviatura);
    if(!abreviatura) throw new Error('La abreviatura es obligatoria');
    const familiaRaw = Object.prototype.hasOwnProperty.call(patch,'familia') ? normalizeUnidadTexto(patch.familia) : normalizeUnidadTexto(current.familia);
    if(!familiaRaw) throw new Error('La familia es obligatoria');
    const familiaNorm = normalizeUnidadFamiliaKey(familiaRaw);
    const esBase = Object.prototype.hasOwnProperty.call(patch,'esBase') ? (patch.esBase === true) : (current.esBase === true);
    let baseUnidadId = esBase ? null : (Object.prototype.hasOwnProperty.call(patch,'baseUnidadId') ? normalizeUnidadTexto(patch.baseUnidadId) : normalizeUnidadTexto(current.baseUnidadId));
    let factor = esBase ? 1 : (Object.prototype.hasOwnProperty.call(patch,'factor') ? parseUnidadFactor(patch.factor) : parseUnidadFactor(current.factor ?? current.factorReferencia ?? current.ratioToBase));
    if(esBase){
      baseUnidadId = null;
      factor = 1;
      const conflictSnap = await unidadesCol.where('familiaNorm','==', familiaNorm).limit(25).get();
      const hasOtherBase = conflictSnap.docs.some(doc=> doc.id !== unitId && doc.data()?.esBase === true);
      if(hasOtherBase) throw new Error('Ya existe una unidad base en esta familia');
    } else {
      if(!baseUnidadId) throw new Error('Selecciona la unidad base de referencia');
      if(baseUnidadId === unitId) throw new Error('La unidad no puede referenciarse a sí misma');
      const baseSnap = await unidadesCol.doc(baseUnidadId).get();
      if(!baseSnap.exists) throw new Error('La unidad base seleccionada no existe');
      const baseData = baseSnap.data()||{};
      if(baseData.esBase !== true) throw new Error('La unidad de referencia debe estar marcada como base');
      const baseFamilia = baseData.familiaNorm || normalizeUnidadFamiliaKey(baseData.familia || baseData.familiaLower || '');
      if(baseFamilia && baseFamilia !== familiaNorm) throw new Error('La unidad base pertenece a otra familia');
      if(factor == null) throw new Error('El factor de conversión debe ser mayor a 0');
    }
    let notasField;
    if(Object.prototype.hasOwnProperty.call(patch,'notas')){
      const notas = normalizeUnidadTexto(patch.notas);
      notasField = notas ? notas : null;
    }
    const estatus = Object.prototype.hasOwnProperty.call(patch,'estatus')
      ? (String(patch.estatus||'').trim() || 'Activa')
      : (current.estatus || 'Activa');
    const updatePayload = deepClean({
      nombre,
      nombreLower: nombre.toLowerCase(),
      abreviatura,
      abreviaturaLower: abreviatura.toLowerCase(),
      familia: familiaRaw,
      familiaLower: familiaNorm,
      familiaNorm,
      esBase,
      baseUnidadId: esBase ? null : (baseUnidadId || null),
      factor: esBase ? 1 : factor,
      factorReferencia: esBase ? 1 : factor,
      ratioToBase: esBase ? 1 : factor,
      estatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: uid
    });
    if(Object.prototype.hasOwnProperty.call(patch,'estatus') && !estatus){
      updatePayload.estatus = 'Activa';
    }
    if(Object.prototype.hasOwnProperty.call(patch,'notas')){
      if(notasField){
        updatePayload.notas = notasField;
      } else {
        updatePayload.notas = firebase.firestore.FieldValue.delete();
      }
    }
    await ref.set(updatePayload, { merge:true });
  },
  // ==============================
  // Categorías de Gasto (catálogo)
  // ==============================
  async addGastoCategoria(descripcion){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const d = String(descripcion||'').trim(); if(!d) throw new Error('Descripción requerida');
    const uid = window.auth?.currentUser?.uid || null;
    const ref = col(collectionsMap.gastoCategorias).doc();
    // Asignar código global único de 8+ dígitos (como Categorías)
    const codigo = await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
    // Número secuencial interno
    const numero = await window.firebaseApi.nextCounter('gastoCategoriaNumero', 0);
    await ref.set({ descripcion:d, descripcionLower:d.toLowerCase(), numero, codigo, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: uid });
    return ref.id;
  },
  async updateGastoCategoria(id, descripcion){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const d = String(descripcion||'').trim(); if(!d) throw new Error('Descripción requerida');
    const uid = window.auth?.currentUser?.uid || null;
    await col(collectionsMap.gastoCategorias).doc(id).set({ descripcion:d, descripcionLower:d.toLowerCase(), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge:true });
  },
  /** Generic patch para categorías de gasto (por ejemplo estatus='Inactiva') */
  async updateGastoCategoriaFields(id, patch){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const uid = window.auth?.currentUser?.uid || null;
    const data = { ...deepClean(patch), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid };
    await col(collectionsMap.gastoCategorias).doc(id).set(data, { merge:true });
    auditLog && auditLog('update','gasto_categoria', id, Object.keys(patch));
  },
  async deleteGastoCategoria(id){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
  const uid = window.auth?.currentUser?.uid || null;
  await col(collectionsMap.gastoCategorias).doc(id).set({ estatus: 'Inactiva', updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: uid }, { merge:true });
  auditLog && auditLog('disable','gasto_categoria', id, { estatus:'Inactiva' });
  },
  /** Backfill: asigna código 8 dígitos a categorías de gasto que no lo tengan. Devuelve cuántas actualizó. */
  async backfillGastoCategoriaCodigo8(limit=300){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const catCol = col(collectionsMap.gastoCategorias);
    const snap = await catCol.limit(limit).get();
    let updated = 0;
    for(const doc of snap.docs){
      const d = doc.data()||{};
      if(d.codigo && /^\d{8,}$/.test(String(d.codigo))) continue;
      try{
        const codigo = await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
        await catCol.doc(doc.id).set({ codigo, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        updated++;
      }catch(e){ console.warn('[GastoCategorias][backfillCodigo8] fallo en', doc.id, e?.message||e); }
    }
    return updated;
  },
  // Upsert por nombre normalizado: evita duplicados por descripcion
  async upsertProductoByDescripcionLower(nombre, fields){
    if(!window._firebaseReady){ throw new Error('Firebase no inicializado'); }
    const norm = String(nombre||'').trim().toLowerCase(); if(!norm) throw new Error('Nombre requerido');
    const q = await col(collectionsMap.productos).where('descripcionLower','==', norm).limit(1).get();

    const normalizeVariantName = (s)=>{
      try{
        return String(s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      }catch(_e){
        return String(s||'').trim().toLowerCase();
      }
    };
    const applyVariantAdjustments = (variants, adjustments)=>{
      const list = Array.isArray(variants) ? variants.map(v=> ({ ...v })) : [];
      const index = new Map();
      list.forEach(v=>{
        const key = normalizeVariantName(v?.nombre);
        if(key){ index.set(key, v); }
      });
      adjustments.forEach(adj=>{
        const rawName = String(adj?.nombre||'').trim();
        const qty = Number(adj?.cantidad||0);
        if(!rawName || !Number.isFinite(qty) || qty === 0) return;
        const key = normalizeVariantName(rawName);
        if(!key) return;
        let target = index.get(key);
        if(!target){
          target = { nombre: rawName };
          list.push(target);
          index.set(key, target);
        } else if(!target.nombre){
          target.nombre = rawName;
        }
        const current = Number(target.existencias||0);
        target.existencias = current + qty;
      });
      return list;
    };

    const adjustmentList = Array.isArray(fields?.variantExistenciasAdjust)
      ? fields.variantExistenciasAdjust.map(v=> ({
          nombre: String(v?.nombre||'').trim(),
          cantidad: Number(v?.cantidad||0)
        })).filter(v=> v.nombre && Number.isFinite(v.cantidad) && v.cantidad !== 0)
      : [];

    const base = { descripcion: nombre, descripcionLower: norm, inventario: 'SI', ...fields };
    delete base.variantExistenciasAdjust;
    Object.keys(base).forEach(k=>{ if(base[k] === undefined) delete base[k]; });

    if(!q.empty){
      const doc = q.docs[0];
      const docData = doc.data() || {};
      const patch = { ...base, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      const inc = Number(fields?.existenciasIncrement||0);
      delete patch.existenciasIncrement;

      let totalVariantExist = null;
      if(adjustmentList.length){
        const sourceVariants = Array.isArray(base.variantes)
          ? base.variantes
          : Array.isArray(docData.variantes) ? docData.variantes : [];
        const mergedVariants = applyVariantAdjustments(sourceVariants, adjustmentList);
        patch.variantes = mergedVariants;
        totalVariantExist = mergedVariants.reduce((sum, v)=> sum + (Number(v?.existencias||0)||0), 0);
      }
      if(totalVariantExist !== null){
        patch.existencias = totalVariantExist;
      } else if(Number.isFinite(inc) && inc){
        patch.existencias = firebase.firestore.FieldValue.increment(inc);
      }

      const cleanPatch = deepClean(patch);
      delete cleanPatch.variantExistenciasAdjust;
      await col(collectionsMap.productos).doc(doc.id).set(cleanPatch, { merge:true });
      return { id: doc.id, merged: true };
    } else {
      const payload = { ...base };
      const inc = Number(fields?.existenciasIncrement||0);
      delete payload.existenciasIncrement;

      let totalVariantExist = null;
      if(adjustmentList.length){
        const sourceVariants = Array.isArray(payload.variantes) ? payload.variantes : [];
        const mergedVariants = applyVariantAdjustments(sourceVariants, adjustmentList);
        payload.variantes = mergedVariants;
        totalVariantExist = mergedVariants.reduce((sum, v)=> sum + (Number(v?.existencias||0)||0), 0);
      }
      if(totalVariantExist !== null){
        payload.existencias = totalVariantExist;
      } else if(Number.isFinite(inc) && inc){
        payload.existencias = Number(payload.existencias||0) + inc;
      }

      delete payload.variantExistenciasAdjust;
      const id = await window.firebaseApi.addProducto(payload);
      return { id, created: true };
    }
  },
  // Deduplicar productos por nombre normalizado combinando existencias
  async dedupeProductosByNombre(){
    try{
      const snap = await col(collectionsMap.productos).get();
      const groups = new Map();
      snap.forEach(d=>{
        const data = d.data();
        const key = String(data.descripcion||'').trim().toLowerCase();
        if(!key) return;
        const arr = groups.get(key) || [];
        arr.push({ id: d.id, ...data });
        groups.set(key, arr);
      });
      const batch = window.db.batch();
      let changes = 0;
      for(const [key, arr] of groups.entries()){
        if(arr.length <= 1) continue;
        // Elegir maestro (el más antiguo por createdAt si existe)
        arr.sort((a,b)=> (a.createdAt?.toMillis?.()||0) - (b.createdAt?.toMillis?.()||0));
        const master = arr[0];
        const others = arr.slice(1);
        const sumExist = arr.reduce((s,p)=> s + Number(p.existencias||0), 0);
        const masterRef = col(collectionsMap.productos).doc(master.id);
        batch.set(masterRef, { descripcionLower: key, existencias: sumExist }, { merge:true });
        // En lugar de borrar duplicados, marcarlos como inactivos y poner existencias en 0
        others.forEach(o=>{
          batch.set(col(collectionsMap.productos).doc(o.id), { estatus: 'Inactivo', existencias: 0, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        });
        changes += others.length;
      }
      if(changes){ await batch.commit(); console.info(`[Productos] Deduplicados ${changes} duplicados por nombre`); }
    }catch(e){ console.warn('dedupeProductosByNombre error', e); }
  },
  async deleteProducto(id){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
  const prodRef = col(collectionsMap.productos).doc(id);
  await prodRef.set({ estatus: 'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
  auditLog && auditLog('disable','producto', id, { estatus:'Inactivo' });
  },
  /** Diagnóstico: lista productos sospechosos donde precio==costo o precio<=0 teniendo precioPublico>0. Opcionalmente repara (fix=true) copiando precioPublico a precio si es válido. */
  async diagnosticarPreciosSospechosos({ fix=false }={}){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const snap = await col(collectionsMap.productos).get();
    const sospechosos = [];
    const batch = fix? window.db.batch() : null;
    snap.forEach(doc=>{
      const d = doc.data()||{};
      const precio = Number(d.precio)||0;
      const costo = Number(d.costo)||0;
      const pub = Number(d.precioPublico)||0;
      const igualCosto = (precio>0) && (precio===costo) && (pub>0) && (pub!==precio);
      const ceroConPub = !(precio>0) && (pub>0);
      if(igualCosto || ceroConPub){
        sospechosos.push({ id: doc.id, descripcion: d.descripcion||'', precio, costo, precioPublico: pub });
        if(batch && (pub>0)){
          batch.set(col(collectionsMap.productos).doc(doc.id), { precio: pub }, { merge:true });
        }
      }
    });
    if(batch && sospechosos.length){ await batch.commit(); }
    return sospechosos;
  },
  /** Sincroniza/Backfill categorías tomando los nombres usados en productos. Crea categorías faltantes. */
  async syncCategoriasFromProductos(limit=500){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const prodSnap = await col(collectionsMap.productos).limit(limit).get();
    const names = new Set();
    prodSnap.forEach(d=>{ const c = (d.data().categoria||'').trim(); if(c) names.add(c); });
    if(!names.size) return 0;
    const catCol = col(collectionsMap.categorias);
    let created = 0;
  const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
    for(const name of names){
      const lower = name.toLowerCase();
      const q = await catCol.where('nombreLower','==', lower).limit(1).get();
      if(q.empty){
  const numero = await window.firebaseApi.getUniqueCategoriaNumero();
    await catCol.doc().set({ nombre: name, nombreLower: lower, numero, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: uid });
        created++;
      }
    }
    if(created) console.info(`[Categorias] Backfill creadas: ${created}`);
    return created;
  },
  /** Asigna códigos internos únicos a productos que no lo tienen o es inválido. Procesa hasta 'limit' docs. */
  async backfillCodigosInternos(limit=200){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
  const snap = await col(collectionsMap.productos).limit(limit).get();
    let updated = 0;
    for(const doc of snap.docs){
      const d = doc.data();
      const hasValid = d.codigoInterno && /^\d{8}$/.test(String(d.codigoInterno));
      if(hasValid) continue;
      const prodRef = col(collectionsMap.productos).doc(doc.id);
      try{
    const code = await getUniqueCodigoInterno('');
    await prodRef.update({ codigoInterno: code, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        updated++;
      }catch(_e){ console.warn('No se pudo asignar código a', doc.id, _e?.message||_e); }
    }
    return updated;
  },
  // Caja movimientos (gasto / retiro / ingreso manual)
  async registrarMovimientoCaja(data){
    // data: { tipo:'Gasto'|'Retiro'|'Ingreso', fecha(YYYY-MM-DD), monto, descripcion, categoria?, categoriaId?, categoriaNombre?, metodo? }
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
    const { tipo, fecha, monto, descripcion, categoria=null, categoriaId=null, categoriaNombre=null, metodo='Efectivo' } = data;
    if(!tipo || !fecha || typeof monto!=='number' || monto<=0) throw new Error('Datos incompletos movimiento');
    // Usuario/Sucursal opcionales provenientes de la UI
    const usuarioName = (data && data.usuario) ? String(data.usuario).trim() : (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
    // Sucursal: si no viene en data, priorizar la del perfil del usuario logueado
    let sucursalName = (data && data.sucursal) ? String(data.sucursal).trim() : null;
    if(!sucursalName){
      try{
        const uid2 = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
        const us = Array.isArray(window.usuarios) ? window.usuarios : [];
        const me = us.find(u=> String(u.id||u.uid)===String(uid2));
        const s = (me && typeof me.sucursal==='string' && me.sucursal.trim()) ? me.sucursal.trim() : '';
        if(s) sucursalName = s;
      }catch(_e){}
    }

    // Normalizar tipo
    const tipoUp = String(tipo||'').toUpperCase();

  // Generar folio de caja (general) y, para Gasto/Ingreso, los nuevos folios específicos
    let folioNum = null, folioStr = null;
    try {
      folioNum = await window.firebaseApi.nextCounter('cajaFolio', 0);
      folioStr = String(folioNum).padStart(3,'0');
    } catch(_e) { /* si falla el counter, continuar sin folio */ }

    // Nuevo: folio para Gasto con prefijo G- y parte numérica creciente desde 01001
    let gastoFolio = null;
    if (tipoUp === 'GASTO') {
      try {
        const n = await window.firebaseApi.nextCounter('gastosFolio', 1000); // 1000 -> empieza en 01001
        const width = Math.max(5, String(n).length);
        gastoFolio = `G-${String(n).padStart(width,'0')}`;
      } catch(_e) {
        // Si falla el counter, deja gastoFolio en null para no bloquear el registro
      }
    }
    // Nuevo: folio para Ingreso con prefijo I- y parte numérica creciente desde 01001
    let ingresoFolio = null;
  if (tipoUp === 'INGRESO') {
      try {
    const n = await window.firebaseApi.nextCounter('ingresosFolio', 999);
        const width = Math.max(5, String(n).length);
        ingresoFolio = `I-${String(n).padStart(width,'0')}`;
      } catch(_e) {
        // Si falla el counter, deja ingresoFolio en null
      }
    }
    // Nuevo: folio para Retiro con prefijo R- y parte numérica creciente desde 01001
    let retiroFolio = null;
    if (tipoUp === 'RETIRO') {
      try {
        const n = await window.firebaseApi.nextCounter('retirosFolio', 999);
        const width = Math.max(5, String(n).length);
        retiroFolio = `R-${String(n).padStart(width,'0')}`;
      } catch(_e) {
        // Si falla el counter, deja retiroFolio en null
      }
    }

    const ref = col(collectionsMap.caja).doc();
    // Quitar id8 para Gasto, Ingreso y Retiro (reemplazados por folios específicos). Mantener id8 para otros tipos.
    let id8 = null;
    if (tipoUp !== 'GASTO' && tipoUp !== 'INGRESO' && tipoUp !== 'RETIRO') {
      try { id8 = await window.firebaseApi.getNextCajaId8(); } catch(_e){}
    }
    // Resolver caja del usuario logueado (si está activo y coincide sucursal)
    let cajaName = undefined;
    let cajaId = undefined;
    try{
      const uid2 = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
      const us = Array.isArray(window.usuarios) ? window.usuarios : [];
      const me = us.find(u=> String(u.id||u.uid)===String(uid2));
      const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
      const sucMatch = !sucursalName || !me?.sucursal || String(me.sucursal).toLowerCase()===String(sucursalName).toLowerCase();
      if(active && sucMatch){
        if(me?.caja) cajaName = String(me.caja);
        if(me?.cajaId) cajaId = String(me.cajaId);
      }
    }catch(_e){ cajaName = undefined; }
    const payload = {
      id8: id8 || null,
      folio: folioNum || null,
      folioStr: folioStr || null,
      gastoFolio: gastoFolio || null,
      ingresoFolio: ingresoFolio || null,
      retiroFolio: retiroFolio || null,
      tipo: tipoUp==='RETIRO'?'Retiro': (tipoUp==='GASTO'?'Gasto':'Ingreso'),
      fecha,
      monto,
      descripcion: descripcion||'',
      categoria: categoria||categoriaNombre||null,
      categoriaId: categoriaId||null,
      categoriaNombre: categoriaNombre||categoria||null,
      metodo,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      userId: uid,
      usuario: usuarioName || undefined,
  cajaId: cajaId || undefined,
  caja: cajaName || undefined,
      sucursal: sucursalName || undefined
    };
    // Enlazar al turno abierto si existe
    try{
      const turnoId = window.currentTurnoId || null;
      if(turnoId){
        payload.turnoId = turnoId;
        // Intentar obtener open approx ms si ya está en memoria (no llamar a Firestore extra)
        // Asumimos que se guardará luego en el corte para filtrar.
      }
    }catch(_e){}
    payload.createdAtMs = Date.now();
    try{
      // Copiar marca de apertura aproximada si existe un turno cargado en cache (no hacemos fetch extra)
      if(window.__lastTurnoOpen && window.__lastTurnoOpen.id === window.currentTurnoId && window.__lastTurnoOpen.abiertoEnApproxMs){
        payload.turnoOpenApproxMs = window.__lastTurnoOpen.abiertoEnApproxMs;
      }
    }catch(_e){}
    await ref.set(deepClean(payload));
    return ref.id;
  },
  // Insumos
  async addInsumo(data){ const ref = await col(collectionsMap.insumos).add({...data, createdAt: firebase.firestore.FieldValue.serverTimestamp()}); return ref.id; },
  async updateInsumo(id,data){ return col(collectionsMap.insumos).doc(id).update({...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp()}); },
  /** Registra una entrada de historial de consumible (uso/reemplazo). */
  async logConsumibleHist(entry){
    const clean = deepClean({
      productoId: entry?.productoId||null,
      productoDesc: entry?.productoDesc||null,
      modo: entry?.modo||null, // 'impresiones' | 'dias' | 'reemplazo'
      impresiones: typeof entry?.impresiones==='number'? entry.impresiones : null,
      maquinaId: entry?.maquinaId||null,
      contadorId: entry?.contadorId||null,
      motivo: entry?.motivo||null,
      fecha: entry?.fecha || getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City'),
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: entry?.createdBy|| (window.auth?.currentUser?.uid||null)
    });
    const ref = await col(collectionsMap.consumiblesHistorial).add(clean);
    return ref.id;
  },
  /** Incrementa el desgaste (unidades) de un consumible y registra historial en una transacción. */
  async incrementarDesgasteConsumible({ productoId, unidades, maquinaId, contadorId, fecha, origenProductoId, origenProductoDesc, origenVentaFolio }){
    if(!productoId) throw new Error('productoId requerido');
    const inc = Number(unidades||0);
    if(!(inc>0)) return { ok:false, reason:'unidades<=0' };
    const tz = window.__FECHA_TZ__ || 'America/Mexico_City';
    const fechaStr = fecha || getTodayStrTZ(tz);
    const ref = col(collectionsMap.productos).doc(String(productoId));
    const histRef = col(collectionsMap.consumiblesHistorial).doc();
    await window.db.runTransaction(async (tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists) throw new Error('Producto no existe');
      const data = snap.data()||{};
      const prev = Number(data.consumibleWearActual||0);
      const setObj = {
        consumibleWearActual: prev + inc,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if(!data.consumibleWearDesde){ setObj.consumibleWearDesde = firebase.firestore.FieldValue.serverTimestamp(); }
      tx.update(ref, setObj);
      // Log historial en la misma transacción
      const hist = {
        productoId: String(productoId),
        productoDesc: data.descripcion||null,
        modo: 'impresiones',
        impresiones: inc,
        maquinaId: maquinaId||data.consumibleMaquinaId||null,
        contadorId: contadorId||data.consumibleContadorId||null,
        fecha: fechaStr,
        // Campos de origen para desglose por producto fabricado/venta
        ventaProductoId: origenProductoId||null,
        ventaProductoDesc: origenProductoDesc||null,
        ventaFolio: origenVentaFolio||null,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: (window.auth?.currentUser?.uid)||null
      };
      tx.set(histRef, deepClean(hist));
    });
    return { ok:true };
  },
  /** Lista historial de desgaste (impresiones) de un consumible con campos de origen para desglose. */
  async listConsumibleWearOrigen(productoId, limit=200){
    if(!productoId) throw new Error('productoId requerido');
    const qBase = col(collectionsMap.consumiblesHistorial)
      .where('productoId','==', String(productoId))
      .where('modo','==','impresiones');
    let snap;
    try{
      // Preferimos ordenar por ts desc, pero esto puede requerir índice compuesto.
      snap = await qBase.orderBy('ts','desc').limit(limit).get();
    } catch(err){
      // Si falta índice, hacemos fallback sin orderBy para no bloquear la UI.
      const code = String(err && (err.code||err.name)||'');
      if(code.includes('failed-precondition')){
        snap = await qBase.limit(limit).get();
      } else {
        throw err;
      }
    }
    const rows = [];
    snap.forEach(d=>{ const x=d.data(); rows.push({
      id: d.id,
      productoId: x.productoId,
      productoDesc: x.productoDesc||null,
      impresiones: x.impresiones||0,
      fecha: x.fecha||null,
      tsMillis: (x.ts && typeof x.ts.toMillis==='function') ? x.ts.toMillis() : null,
      ventaProductoId: x.ventaProductoId||null,
      ventaProductoDesc: x.ventaProductoDesc||null,
      ventaFolio: x.ventaFolio||null,
    }); });
    return rows;
  },
  /** Marca consumible como "acabado": decrementa existencias (si aplica) y reinicia desgaste; registra historial. */
  async marcarConsumibleAcabado({ productoId, motivo }){
    if(!productoId) throw new Error('productoId requerido');
    const tz = window.__FECHA_TZ__ || 'America/Mexico_City';
    const fechaStr = getTodayStrTZ(tz);
    const ref = col(collectionsMap.productos).doc(String(productoId));
    const histRef = col(collectionsMap.consumiblesHistorial).doc();
    let result = { ok:false, existencias:null };
    await window.db.runTransaction(async (tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists) throw new Error('Producto no existe');
      const data = snap.data()||{};
      const inv = String(data.inventario||'').toUpperCase();
      const exist = Number(data.existencias||0);
      const updates = {
        consumibleWearActual: 0,
        consumibleWearDesde: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if(inv==='SI' && exist>0){ updates.existencias = firebase.firestore.FieldValue.increment(-1); result.existencias = exist-1; }
      else { result.existencias = exist; }
      tx.update(ref, updates);
      const hist = {
        productoId: String(productoId),
        productoDesc: data.descripcion||null,
        modo: 'reemplazo',
        motivo: motivo||'acabado',
        fecha: fechaStr,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: (window.auth?.currentUser?.uid)||null
      };
      tx.set(histRef, deepClean(hist));
      result.ok = true;
    });
    return result;
  },
  async deleteInsumo(id){ return col(collectionsMap.insumos).doc(id).set({ estatus:'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); },
  // Caja
  async addMovimientoCaja(data){
    const ref = col(collectionsMap.caja).doc();
    const tipoUp = String(data?.tipo||'').toUpperCase();
    // Para Gasto/Ingreso/Retiro: crear nuevos folios específicos; para otros, conservar id8
    let gastoFolio = null; let ingresoFolio = null; let retiroFolio = null; let id8 = null;
    if (tipoUp === 'GASTO') {
      try {
        const n = await window.firebaseApi.nextCounter('gastosFolio', 1000);
        const width = Math.max(5, String(n).length);
        gastoFolio = `G-${String(n).padStart(width,'0')}`;
      } catch(_e){}
  } else if (tipoUp === 'INGRESO') {
      try {
    const n = await window.firebaseApi.nextCounter('ingresosFolio', 999);
        const width = Math.max(5, String(n).length);
        ingresoFolio = `I-${String(n).padStart(width,'0')}`;
      } catch(_e){}
    } else if (tipoUp === 'RETIRO') {
      try {
        const n = await window.firebaseApi.nextCounter('retirosFolio', 999);
        const width = Math.max(5, String(n).length);
        retiroFolio = `R-${String(n).padStart(width,'0')}`;
      } catch(_e){}
    } else {
      try { id8 = await window.firebaseApi.getNextCajaId8(); } catch(_e){}
    }
    // Derive caja when missing, from logged user if active and sucursal matches (or not provided)
    let cajaName = data && data.caja ? String(data.caja) : undefined;
    let cajaId = data && data.cajaId ? String(data.cajaId) : undefined;
    try{
      if(!(cajaName && cajaId)){
        const uid = window.auth?.currentUser?.uid || null;
        const users = Array.isArray(window.usuarios)? window.usuarios : [];
        const me = uid ? users.find(u=> String(u.id||u.uid)===String(uid)) : null;
        const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
        const sucData = (typeof data?.sucursal==='string' && data.sucursal.trim()) ? data.sucursal.trim() : null;
        const sucMatch = !sucData || !me?.sucursal || String(me.sucursal).toLowerCase()===String(sucData).toLowerCase();
        if(active && sucMatch){ if(me?.caja) cajaName = String(me.caja); if(me?.cajaId) cajaId = String(me.cajaId); }
      }
    }catch(_e){}
  // Strict mode: bloquear si no hay turno abierto (configurable)
  const strictTurno = !!(window.__TURNOS_CFG__ && window.__TURNOS_CFG__.strict);
  const activeTurnoId = window.currentTurnoId || data.turnoId || null;
  if(strictTurno && !activeTurnoId){ throw new Error('No hay turno abierto.'); }
  await ref.set(deepClean({ ...data, turnoId: (activeTurnoId||null), cajaId: cajaId || undefined, caja: cajaName || undefined, gastoFolio: gastoFolio||null, ingresoFolio: ingresoFolio||null, retiroFolio: retiroFolio||null, id8: id8 || null, createdAt: firebase.firestore.FieldValue.serverTimestamp() }));
    return ref.id;
  }
  ,
  /** Asigna folios secuenciales a movimientos de caja que no los tengan todavía. */
  async backfillCajaFolios(limit=500){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const cajaCol = col(collectionsMap.caja);
    // Tomar los más antiguos primero para conservar orden histórico
    const snap = await cajaCol.orderBy('fecha','asc').limit(limit).get();
    let updated = 0;
    for(const doc of snap.docs){
      const d = doc.data();
      const tipoUp = String(d?.tipo||'').toUpperCase();
      let setObj = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if(!(d.folio!=null || d.folioStr)){
        let folioNum = null, folioStr = null;
        try{ folioNum = await window.firebaseApi.nextCounter('cajaFolio', 0); folioStr = String(folioNum).padStart(3,'0'); }catch(_e){}
        setObj.folio = folioNum||null; setObj.folioStr = folioStr||null;
      }
      if(tipoUp==='GASTO' && !d.gastoFolio){
        try{ const n = await window.firebaseApi.nextCounter('gastosFolio', 1000); const width=Math.max(5,String(n).length); setObj.gastoFolio = `G-${String(n).padStart(width,'0')}`; }catch(_e){}
      }
      if(tipoUp==='INGRESO' && !d.ingresoFolio){
        try{ const n = await window.firebaseApi.nextCounter('ingresosFolio', 999); const width=Math.max(5,String(n).length); setObj.ingresoFolio = `I-${String(n).padStart(width,'0')}`; }catch(_e){}
      }
      if(tipoUp==='RETIRO' && !d.retiroFolio){
        try{ const n = await window.firebaseApi.nextCounter('retirosFolio', 999); const width=Math.max(5,String(n).length); setObj.retiroFolio = `R-${String(n).padStart(width,'0')}`; }catch(_e){}
      }
      try{
        await cajaCol.doc(doc.id).set(setObj, { merge:true });
        updated++;
      }catch(e){ console.warn('No se pudo actualizar folio de caja', doc.id, e?.message||e); }
    }
    return updated;
  },
  // Compras (historial)
  async addCompra(data){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const payload = {
      fecha: data.fecha || new Date().toISOString().slice(0,10),
      factura: data.factura || null,
      vista: data.vista || 'PRODUCTOS', // 'PRODUCTOS' | 'INSUMOS'
      total: Number(data.total)||0,
      items: Array.isArray(data.items)? JSON.parse(JSON.stringify(data.items)) : [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      userId: window.auth?.currentUser?.uid || null
    };
    const ref = await col(collectionsMap.compras).add(payload);
    return ref.id;
  },
  /** Lista documentos de compras para historial (real) desde Firestore. */
  async listCompras(limit=300){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const comprasCol = col(collectionsMap.compras);
    // Preferimos ordenar por fecha ascendente para calcular acumulados fácilmente
    const snap = await comprasCol.orderBy('fecha','asc').limit(limit).get();
    const arr = [];
    snap.forEach(doc=>{ const d = doc.data() || {}; arr.push({ id: doc.id, ...d }); });
    return arr;
  },
  // Cortes de caja (resúmenes diarios)
  async listCortes({ limit=60, fecha=null }={}){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const cortesCol = col(collectionsMap.cajaCortes);
    let q = cortesCol.orderBy('fecha','desc').limit(Number(limit)||60);
    if(fecha){ q = cortesCol.where('fecha','==', String(fecha)).orderBy('fecha','desc').limit(Number(limit)||60); }
    const snap = await q.get();
    const arr=[]; snap.forEach(doc=> arr.push({ id:doc.id, ...doc.data() }));
    return arr;
  },
  /** Obtiene el corte de hoy para la caja asignada al usuario actual (si existe). */
  async getTodayCorteForMyCaja(){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const tz = window.__CORTE_TZ__ || 'America/Mexico_City';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    const list = await this.listCortes({ fecha: today, limit: 50 });
    const uid = window.auth?.currentUser?.uid || null;
    try{
      const users = Array.isArray(window.usuarios)? window.usuarios : [];
      const me = uid ? users.find(u=> String(u.id||u._docId)===String(uid)) : null;
      const cajaId = me?.cajaId ? String(me.cajaId) : null;
      const cajaName = me?.caja ? String(me.caja) : null;
      const match = list.find(c=> (c.cajaId && cajaId && String(c.cajaId)===cajaId) || (!c.cajaId && cajaName && String(c.caja||'').toUpperCase()===cajaName.toUpperCase()));
      return match || null;
    }catch(_e){ return list[0] || null; }
  },
  // =====================
  // Cajas (catálogo fijo)
  // =====================
  async addCaja(data){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const nombre = String(data?.nombre||'').trim();
    const suc = String(data?.sucursal||'').trim();
    if(!nombre) throw new Error('Nombre requerido');
    if(!suc) throw new Error('Sucursal requerida');
    const estatus = String(data?.estatus||'Activa');
    const payload = deepClean({
      nombre,
      nombreLower: nombre.toLowerCase(),
      sucursal: suc,
      estatus,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: window.auth?.currentUser?.uid || null
    });
    const ref = await col(collectionsMap.cajas).add(payload);
    auditLog && auditLog('create','caja', ref.id, {});
    return ref.id;
  },
  async updateCajaFields(id, patch){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const data = deepClean({ ...patch });
    if(Object.prototype.hasOwnProperty.call(data,'nombre')){
      const n = String(data.nombre||'').trim(); if(!n) throw new Error('Nombre requerido');
      data.nombreLower = n.toLowerCase();
    }
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    data.updatedBy = window.auth?.currentUser?.uid || null;
    await col(collectionsMap.cajas).doc(String(id)).set(data, { merge:true });
    auditLog && auditLog('update','caja', id, Object.keys(patch));
  },
  async deleteCaja(id){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    await col(collectionsMap.cajas).doc(String(id)).set({ estatus:'Inactiva', updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: window.auth?.currentUser?.uid || null }, { merge:true });
    auditLog && auditLog('disable','caja', id, { estatus:'Inactiva' });
  },
  /** Auditoría: usuarios con cajaId inexistente o inactiva. Útil para reasignar. */
  findUsuariosConCajaHuerfana(){
    try{
      const us = Array.isArray(window.usuarios)? window.usuarios: [];
      const cs = Array.isArray(window.cajas)? window.cajas: [];
      const byId = new Map(cs.map(c=> [String(c.id), c]));
      return us.filter(u=>{
        const cid = String(u?.cajaId||'').trim();
        if(!cid) return false;
        const c = byId.get(cid);
        if(!c) return true; // missing
        const en = String(c.estatus||'Activa').toLowerCase()==='activa';
        return !en; // inactive
      });
    }catch(_e){ return []; }
  },
  // Utilidad: generar código único de 8 dígitos para cliente
  async generateUniqueClienteCodigo(){
  return await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
  },
  // Utilidad: generar código único de 8 dígitos para sucursal
  async generateUniqueSucursalCodigo(){
  return await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
  },
  // Utilidad: generar código único de 8 dígitos para proveedor
  async generateUniqueProveedorCodigo(){
  return await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
  },
  // Utilidad: generar código único de 8 dígitos para usuario
  async generateUniqueUsuarioCodigo(){
  return await generateUniqueGlobalCodigo({ minWidth:8, maxWidth:14, attemptsPerWidth:40 });
  },
  /** Backfill generic for 8-digit 'codigo' field in a collection using a specific generator */
  async backfillCodigo8For({ colName, generator, scanLimit=800, perBatch=80 }){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const c = col(colName);
    if(!c) throw new Error('Colección no encontrada: '+colName);
    const snap = await c.limit(scanLimit).get();
    const targets = [];
    snap.forEach(doc=>{ const d=doc.data()||{}; const ok = d.codigo && /^\d{8}$/.test(String(d.codigo)); if(!ok) targets.push(doc.id); });
    if(!targets.length) return { updated:0, total: snap.size };
    let updated=0;
    for(let i=0;i<targets.length;i+=perBatch){
      const chunk = targets.slice(i, i+perBatch);
      const batch = window.db.batch();
      for(const id of chunk){
        let code=null; try{ code = await generator(); }catch(_e){}
        if(!code) continue;
        batch.set(c.doc(id), { codigo: code, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
      }
      await batch.commit();
      updated += chunk.length;
    }
    return { updated, total: snap.size };
  },
  /** Backfill for all relevant collections: clientes, sucursales, proveedores, usuarios. */
  async backfillCodigos8All({ scanLimit=800, perBatch=80 }={}){
    const res = {};
    try { res.clientes = await window.firebaseApi.backfillCodigo8For({ colName: collectionsMap.clientes, generator: window.firebaseApi.generateUniqueClienteCodigo, scanLimit, perBatch }); } catch(e){ res.clientes = { error: e.message }; }
    try { res.sucursales = await window.firebaseApi.backfillCodigo8For({ colName: collectionsMap.sucursales, generator: window.firebaseApi.generateUniqueSucursalCodigo, scanLimit, perBatch }); } catch(e){ res.sucursales = { error: e.message }; }
    try { res.proveedores = await window.firebaseApi.backfillCodigo8For({ colName: collectionsMap.proveedores, generator: window.firebaseApi.generateUniqueProveedorCodigo, scanLimit, perBatch }); } catch(e){ res.proveedores = { error: e.message }; }
    try { res.usuarios = await window.firebaseApi.backfillCodigo8For({ colName: collectionsMap.usuarios, generator: window.firebaseApi.generateUniqueUsuarioCodigo, scanLimit, perBatch }); } catch(e){ res.usuarios = { error: e.message }; }
  // Silenciado: sin logs ni notificaciones
    return res;
  },
  /** Backfill id8 for caja docs missing it (old records). */
  async backfillCajaId8(limit=600){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const cajaCol = col(collectionsMap.caja);
    const snap = await cajaCol.orderBy('fecha','asc').limit(limit).get();
    let updated=0;
    for(const d of snap.docs){
      const data = d.data()||{};
      if(data.id8) continue;
      try{
        const id8 = await generateUniqueByCounter({ counterKey:'cajaId8', startAt:9999999, colName: collectionsMap.caja, field:'id8', minWidth:8 });
        await cajaCol.doc(d.id).set({ id8, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        updated++;
      }catch(_e){ /* ignore individual fail */ }
    }
    return updated;
  },
  /** Backfill ventas: ensure folioNum and folio (M-xxxxx) exist and are unique. */
  async backfillVentasFolios(limit=500){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const vCol = col('ventas');
    const snap = await vCol.limit(limit).get();
    const seen = new Set();
    let fixed=0;
    for(const d of snap.docs){
      const v = d.data()||{};
      let num = typeof v.folioNum==='number' ? v.folioNum : null;
      // resolve duplicates
      if(num!=null && seen.has(num)) num = null;
      if(num==null){
        try{ num = await window.firebaseApi.nextCounter('ventasFolio', 1000); }catch(_e){ continue; }
      }
      seen.add(num);
      const folio = `M-${String(num).padStart(5,'0')}`;
      try{ await vCol.doc(d.id).set({ folioNum:num, folio, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); fixed++; }catch(_e){}
    }
    return fixed;
  },
  /** Backfill cotizaciones: assign missing/duplicate folios using counters.cotizaciones.seq */
  async backfillCotizacionesFolios(limit=600){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const cCol = col(collectionsMap.cotizaciones);
    const snap = await cCol.limit(limit).get();
    const seen = new Set();
    let fixed=0;
    for(const d of snap.docs){
      const x = d.data()||{}; let folio = typeof x.folio==='number'? x.folio : null;
      if(folio!=null && seen.has(folio)) folio = null;
      if(folio==null){
        // Use counters.cotizaciones.seq like create flow
        try{
          const refCounter = col('counters').doc('cotizaciones');
          await window.db.runTransaction(async tx=>{
            const s = await tx.get(refCounter);
            const prev = s.exists && typeof s.data().seq==='number' ? s.data().seq : 60;
            const next = prev + 1;
            tx.set(refCounter,{ seq: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },{ merge:true });
            folio = next;
          });
        }catch(_e){ continue; }
      }
      seen.add(folio);
      try{ await cCol.doc(d.id).set({ folio, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); fixed++; }catch(_e){}
    }
    return fixed;
  },
  /** Backfill facturas: assign missing/duplicate folios using counters.facturas.seq */
  async backfillFacturasFolios(limit=600){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const fCol = col(collectionsMap.facturas);
    const snap = await fCol.limit(limit).get();
    const seen = new Set();
    let fixed=0;
    for(const d of snap.docs){
      const x = d.data()||{}; let folio = typeof x.folio==='number'? x.folio : null;
      if(folio!=null && seen.has(folio)) folio = null;
      if(folio==null){
        try{
          const refCounter = col('counters').doc('facturas');
          await window.db.runTransaction(async tx=>{
            const s = await tx.get(refCounter);
            const prev = s.exists && typeof s.data().seq==='number' ? s.data().seq : 0;
            const next = prev + 1;
            tx.set(refCounter,{ seq: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },{ merge:true });
            folio = next;
          });
        }catch(_e){ continue; }
      }
      seen.add(folio);
      try{ await fCol.doc(d.id).set({ folio, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); fixed++; }catch(_e){}
    }
    return fixed;
  },
  /** Master backfill: ensure all key collections have consistent folios/códigos */
  async backfillFoliosAll(){
    const out = {};
    try{ out.cajaId8 = await window.firebaseApi.backfillCajaId8(800); }catch(e){ out.cajaId8 = { error: e.message }; }
    try{ out.cajaFolios = await window.firebaseApi.backfillCajaFolios(800); }catch(e){ out.cajaFolios = { error: e.message }; }
    try{ out.ventasFolios = await window.firebaseApi.backfillVentasFolios(800); }catch(e){ out.ventasFolios = { error: e.message }; }
    try{ out.cotFolios = await window.firebaseApi.backfillCotizacionesFolios(800); }catch(e){ out.cotFolios = { error: e.message }; }
    try{ out.factFolios = await window.firebaseApi.backfillFacturasFolios(800); }catch(e){ out.factFolios = { error: e.message }; }
    try{ out.codigos8 = await window.firebaseApi.backfillCodigos8All({ scanLimit: 800, perBatch: 80 }); }catch(e){ out.codigos8 = { error: e.message }; }
  // Silenciado: sin logs ni notificaciones
    return out;
  },
  // Clientes
  async addCliente(data){
    const payload = { ...data };
    // Validate or generate codigo
    if(payload.codigo){
      const code = String(payload.codigo).trim();
      if(!/^\d{8,}$/.test(code)) throw new Error('El código debe ser numérico y de al menos 8 dígitos');
      // ensure not used by another client
      const q = await col(collectionsMap.clientes).where('codigo','==', code).limit(1).get();
      if(!q.empty) throw new Error('Código ya está en uso por otro cliente');
      const existsGlobal = await codeExistsAcrossSystem(code);
      if(existsGlobal) throw new Error('Código en uso en el sistema');
      payload.codigo = code;
    } else {
      try { payload.codigo = await this.generateUniqueClienteCodigo(); } catch(_e){ payload.codigo = String(Math.floor(Math.random()*1e8)).padStart(8,'0'); }
    }
    const ref = await col(collectionsMap.clientes).add({ ...payload, nombreLower:(payload.nombre||'').toLowerCase(), createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    return ref.id;
  },
   async updateCliente(id,data){
     const ref = col(collectionsMap.clientes).doc(id);
     const currSnap = await ref.get();
     if(!currSnap.exists) throw new Error('Cliente no encontrado');
     const curr = currSnap.data()||{};
     const currCodigo = String(curr.codigo||'');
     const patch = { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
     if(data.nombre) patch.nombreLower = data.nombre.toLowerCase();
     if(data && typeof data.codigo!=='undefined'){
       const code = String(data.codigo||'').trim();
       if(code){
         if(!/^\d{8,}$/.test(code)) throw new Error('El código debe ser numérico y de al menos 8 dígitos');
         if(code !== currCodigo){
           // ensure not used by another client
           const q = await col(collectionsMap.clientes).where('codigo','==', code).limit(2).get();
           const conflict = !q.empty && q.docs.some(d=> d.id !== id);
           if(conflict) throw new Error('Código ya está en uso por otro cliente');
           // ensure not used elsewhere
           const existsGlobal = await codeExistsAcrossSystem(code);
           if(existsGlobal) throw new Error('Código en uso en el sistema');
         }
         patch.codigo = code;
       } else {
         patch.codigo = firebase.firestore.FieldValue.delete();
       }
     }
    return ref.set(patch, { merge:true });
  },
  async syncPuntosMediosForCliente(clienteId, puntos=[], meta={}){
    if(!window._firebaseReady) throw new Error('Firebase no inicializado');
    const id = String(clienteId||'').trim();
    if(!id) return;
    const colRef = col(collectionsMap.puntosMedios);
    if(!colRef) return;
    let list = Array.isArray(puntos) ? puntos.slice() : [];
    if(list.length > MAX_PUNTOS_MEDIOS_GLOBAL){
      list = list.slice(list.length - MAX_PUNTOS_MEDIOS_GLOBAL);
    }
    const unique = new Map();
    list.forEach(pm=>{
      if(!pm) return;
      const clone = { ...pm };
      const key = clone.key || buildPuntoMedioKey(clone);
      if(!key || unique.has(key)) return;
      clone.key = key;
      if(!clone.ts) clone.ts = Date.now();
      clone.nombre = String(clone.nombre||'').trim();
      clone.coords = String(clone.coords||'').trim();
      unique.set(key, clone);
    });
    const values = Array.from(unique.values());
    const existingSnap = await colRef.where('clienteId','==', id).get();
    const existing = new Map();
    existingSnap.forEach(doc=> existing.set(doc.id, doc));
    if(!values.length && !existing.size) return;
    const batch = window.db.batch();
    let ops = 0;
    const updatedBy = meta?.updatedBy || meta?.createdBy || (window.auth?.currentUser?.uid||null) || null;
    const clienteNombre = meta?.clienteNombre ? String(meta.clienteNombre).trim() : '';
    const clienteNombreLower = clienteNombre ? clienteNombre.toLowerCase() : null;
    values.forEach(pm=>{
      const docId = buildPuntoMedioDocId(id, pm.key);
      const docRef = colRef.doc(docId);
      const exists = existing.has(docId);
      const record = deepClean({
        key: pm.key,
        clienteId: id,
        clienteNombre: clienteNombre || null,
        clienteNombreLower: clienteNombreLower || undefined,
        nombre: pm.nombre,
        calle: pm.calle || '',
        numero: pm.numero || '',
        colonia: pm.colonia || '',
        cp: pm.cp || '',
        ciudad: pm.ciudad || '',
        estado: pm.estado || '',
        pais: pm.pais || '',
        coords: pm.coords,
        ts: Number(pm.ts)||Date.now(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy
      });
      if(!exists) record.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      batch.set(docRef, record, { merge:true });
      existing.delete(docId);
      ops++;
    });
    existing.forEach(doc=>{
      batch.delete(doc.ref);
      ops++;
    });
    if(ops) await batch.commit();
  },
  async deleteCliente(id){ return col(collectionsMap.clientes).doc(id).set({ estatus:'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); }
  ,
  // Proveedores
  async addProveedor(data){
    const payload = { ...data };
    if(!payload.codigo){ try { payload.codigo = await this.generateUniqueProveedorCodigo(); } catch(_e){ payload.codigo = String(Math.floor(Math.random()*1e8)).padStart(8,'0'); } }
    const ref = await col(collectionsMap.proveedores).add({ ...payload, nombreLower:(payload.nombre||'').toLowerCase(), saldo: payload.saldo||0, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    auditLog && auditLog('create','proveedor', ref.id, {});
    return ref.id;
  },
  async updateProveedor(id,data){ const patch={ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }; if(data.nombre) patch.nombreLower=data.nombre.toLowerCase(); await col(collectionsMap.proveedores).doc(id).set(patch,{ merge:true }); auditLog && auditLog('update','proveedor', id, Object.keys(data)); },
  async deleteProveedor(id){ await col(collectionsMap.proveedores).doc(id).set({ estatus:'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('disable','proveedor', id, { estatus:'Inactivo' }); },
  // CXP Proveedores (servicios / cuentas por pagar)
  async addCxpProveedor(data){ const ref = await col(collectionsMap.cxpProveedores).add({ ...data, nombreLower:(data.nombre||'').toLowerCase(), saldo: data.saldo||0, createdAt: firebase.firestore.FieldValue.serverTimestamp() }); auditLog && auditLog('create','cxp_proveedor', ref.id, {}); return ref.id; },
  async updateCxpProveedor(id,data){ const patch={ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }; if(data.nombre) patch.nombreLower=data.nombre.toLowerCase(); await col(collectionsMap.cxpProveedores).doc(id).set(patch,{ merge:true }); auditLog && auditLog('update','cxp_proveedor', id, Object.keys(data)); },
  async deleteCxpProveedor(id){ await col(collectionsMap.cxpProveedores).doc(id).set({ estatus:'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('disable','cxp_proveedor', id, { estatus:'Inactivo' }); },
  // Usuarios (catálogo/metadatos de aplicación; Auth se maneja con Firebase Auth)
  async addUsuario(data){
    const payload = { ...deepClean(data) };
    const correo = String(payload.correo||payload.email||'').trim();
    const password = String(payload.password||'').trim();
    const displayName = String(payload.nombre||'').trim();
    // Mapear perfil a role token ('Administrador'->'admin','Ventas'->'ventas','Producción'->'produccion','Caja'->'caja')
    if(payload.perfil && !payload.role){
      const p = String(payload.perfil).toLowerCase();
      payload.role = p.includes('admin') ? 'admin' : (p.includes('venta') ? 'ventas' : (p.includes('produ') ? 'produccion' : (p.includes('caja') ? 'caja' : 'usuario')));
    }
    // Crear en Auth si tenemos email+password
    let uid = payload.uid || null;
    if(!uid && correo && password){
      const secAuth = getSecondaryAuth();
      if(!secAuth) throw new Error('Auth no disponible para crear usuario');
      const cred = await secAuth.createUserWithEmailAndPassword(correo, password);
      if(displayName){ try { await cred.user.updateProfile({ displayName }); } catch(_e){} }
      // Enviar verificación de correo al nuevo usuario
      try { await cred.user.sendEmailVerification(); } catch(_e){}
      try { await secAuth.signOut(); } catch(_e){}
      uid = cred.user.uid;
    }
    // Preparar documento (no guardar password)
    delete payload.password; delete payload.uid; delete payload.email; // homogeniza
    payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    payload.createdBy = window.auth?.currentUser?.uid || null;
    if(payload.nombre && !payload.nombreLower) payload.nombreLower = String(payload.nombre).trim().toLowerCase();
    // Asegurar 'codigo' de 8 dígitos único para usuarios
    if(!payload.codigo){
      try { payload.codigo = await window.firebaseApi.generateUniqueUsuarioCodigo(); }
      catch(_e){ payload.codigo = String(Math.floor(Math.random()*1e8)).padStart(8,'0'); }
    }
    const docId = uid || undefined;
    if(docId){ await col(collectionsMap.usuarios).doc(docId).set(payload, { merge:true }); auditLog && auditLog('create','usuario', docId, {}); return docId; }
    const ref = await col(collectionsMap.usuarios).add(payload); auditLog && auditLog('create','usuario', ref.id, {}); return ref.id;
  },
  async updateUsuario(id, data){
  const patch = { ...deepClean(data), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: window.auth?.currentUser?.uid || null };
    // Mapear perfil a role si viene cambio de perfil
    if(patch.perfil && !patch.role){
      const p = String(patch.perfil).toLowerCase();
      patch.role = p.includes('admin') ? 'admin' : (p.includes('venta') ? 'ventas' : (p.includes('produ') ? 'produccion' : (p.includes('caja') ? 'caja' : 'usuario')));
    }
    if(patch.nombre) patch.nombreLower = String(patch.nombre).trim().toLowerCase();
    await col(collectionsMap.usuarios).doc(id).set(patch, { merge:true });
    auditLog && auditLog('update','usuario', id, Object.keys(data));
  },
  async deleteUsuario(id){ await col(collectionsMap.usuarios).doc(id).set({ estatus:'Inactivo', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('disable','usuario', id, { estatus:'Inactivo' }); },
  // Pedido a proveedor (orden de compra básica)
  async addPedidoProveedor(data){
    const { proveedorId, partidas=[], periodicidad='UNICA', proximoVencimiento=null, preavisoDias=3, rec=null } = data;
    if(!proveedorId) throw new Error('proveedorId requerido');
    const ref = col(collectionsMap.pedidosProveedor).doc();
    await ref.set({
      proveedorId,
      partidas: JSON.parse(JSON.stringify(partidas)),
      costoTotal: partidas.reduce((s,p)=> s + (p.costo||0),0),
      estado: 'POR_LLEGAR',
      fechaCreacion: new Date().toISOString().slice(0,10),
      periodicidad,
      proximoVencimiento: proximoVencimiento || null,
      preavisoDias: Number.isFinite(preavisoDias)? preavisoDias : 3,
  createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  rec: rec ? JSON.parse(JSON.stringify(rec)) : null
    });
    auditLog && auditLog('create','pedido_proveedor', ref.id, { proveedorId });
    return ref.id;
  },
  async updatePedidoProveedor(id, patch){ await col(collectionsMap.pedidosProveedor).doc(id).set({ ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('update','pedido_proveedor', id, Object.keys(patch)); },
  async deletePedidoProveedor(id){ await col(collectionsMap.pedidosProveedor).doc(id).set({ estado:'CANCELADO', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('cancel','pedido_proveedor', id, { estado:'CANCELADO' }); },
  // Marcar pedido recibido (ajusta saldo proveedor opcional)
  async recibirPedidoProveedor(id){ const ref = col(collectionsMap.pedidosProveedor).doc(id); await window.db.runTransaction(async tx=>{ const snap=await tx.get(ref); if(!snap.exists) throw new Error('Pedido no existe'); const d=snap.data(); if(d.estado==='RECIBIDO') return; tx.update(ref,{ estado:'RECIBIDO', recibidoAt: firebase.firestore.FieldValue.serverTimestamp() }); if(d.proveedorId){ let provRef = col(collectionsMap.proveedores).doc(d.proveedorId); let ps = await tx.get(provRef); if(!ps.exists){ const altRef = col(collectionsMap.cxpProveedores).doc(d.proveedorId); const alt = await tx.get(altRef); if(alt.exists){ provRef = altRef; } else { provRef = null; } } if(provRef){ tx.set(provRef,{ saldo: firebase.firestore.FieldValue.increment(d.costoTotal||0) },{ merge:true }); } } }); auditLog && auditLog('recibir','pedido_proveedor', id, {}); },
  /** Registra un pago a proveedor: crea doc en pagos_proveedor, movimiento en caja y disminuye saldo del proveedor. */
  async addPagoProveedor({ proveedorId, proveedorNombre, monto, fecha, formaPago, referencia, nota }){
    if(!proveedorId) throw new Error('proveedorId requerido');
    const amount = Number(monto);
    if(!Number.isFinite(amount) || amount <= 0) throw new Error('Monto inválido');
    const pagosRef = col('pagos_proveedor').doc();
    const provRefProd = col(collectionsMap.proveedores).doc(proveedorId);
    const provRefCxp = col(collectionsMap.cxpProveedores).doc(proveedorId);
    const cajaRef = col(collectionsMap.caja).doc();
    const uid = window.auth?.currentUser?.uid || null;
    const f = (fecha && String(fecha).length) ? String(fecha) : new Date().toISOString().slice(0,10);
  await window.db.runTransaction(async(tx)=>{
      let targetRef = provRefProd;
      let ps = await tx.get(targetRef);
      if(!ps.exists){
        const alt = await tx.get(provRefCxp);
        if(!alt.exists) throw new Error('Proveedor no existe');
        targetRef = provRefCxp; ps = alt;
      }
      const pname = proveedorNombre || ps.data().nombre || '';
      tx.set(pagosRef, {
        proveedorId,
        proveedorNombre: pname,
        monto: amount,
        fecha: f,
        formaPago: formaPago || 'TRANSFERENCIA',
        referencia: referencia || '',
        nota: nota || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        userId: uid
      });
      // Sequential 8-digit ID for caja
      let id8 = null; try { id8 = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
  tx.set(cajaRef, deepClean({
        id8: id8 || null,
        fecha: f,
        tipo: 'PAGO_PROVEEDOR',
        monto: -Math.abs(amount),
        proveedorId,
        referencia: referencia || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        userId: uid
  }));
      tx.set(targetRef, { saldo: firebase.firestore.FieldValue.increment(-Math.abs(amount)) }, { merge:true });
    });
    auditLog && auditLog('create','pago_proveedor', pagosRef.id, { proveedorId, monto: amount });
    return pagosRef.id;
  },
  /** Alta rápida de recibo de servicio como pedido_proveedor con vencimiento (CFE, Izzi, etc.). */
  async quickAddReciboServicio({ proveedorNombre, servicio, periodo, monto, vence, referencia }){
    const provName = String(proveedorNombre || servicio || '').trim();
    if(!provName) throw new Error('Proveedor/servicio requerido');
    const amount = Number(monto)||0; if(amount<=0) throw new Error('Monto inválido');
    const due = vence || new Date().toISOString().slice(0,10);
    // Buscar o crear proveedor por nombreLower
    const provCol = col(collectionsMap.proveedores);
    let proveedorId = null;
    const q = await provCol.where('nombreLower','==', provName.toLowerCase()).limit(1).get();
    if(q.empty){
      const newRef = provCol.doc();
      await newRef.set({ nombre: provName, nombreLower: provName.toLowerCase(), saldo: 0, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      proveedorId = newRef.id;
    } else { proveedorId = q.docs[0].id; }
    // Crear pedido_proveedor con una línea
    const pedidoRef = col(collectionsMap.pedidosProveedor).doc();
    const partida = { descripcion: `${servicio||provName} ${periodo||''}`.trim(), costo: amount, fechaEntrega: due };
    await pedidoRef.set({ proveedorId, servicio: servicio||provName, periodo: periodo||'', referencia: referencia||'', partidas:[partida], costoTotal: amount, estado:'POR_LLEGAR', fechaCreacion: new Date().toISOString().slice(0,10), vence: due, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    auditLog && auditLog('create','pedido_proveedor_recibo', pedidoRef.id, { proveedorId, amount });
    return pedidoRef.id;
  },
  // Pagos (complementos) – registro genérico (no timbra, solo contable)
  async addPago(data){ const ref = col(collectionsMap.pagos).doc(); const { facturas=[] } = data; const payload = { fecha: data.fecha|| new Date().toISOString().slice(0,10), formaPago: data.formaPago||'EFECTIVO', folioPago: data.folioPago||null, importe: data.importe||0, noOperacion: data.noOperacion||'', cliente: data.cliente||'', facturas: facturas.map(f=>({ facturaId:f.facturaId||null, monto:f.monto||0 })), createdAt: firebase.firestore.FieldValue.serverTimestamp(), userId: window.auth?.currentUser?.uid||null };
    await ref.set(payload); auditLog && auditLog('create','pago', ref.id, { importe: payload.importe });
    // Aplicar abonos a facturas (transaction por cada factura para mantener integridad saldo)
    for(const fx of payload.facturas){
      if(fx.facturaId && fx.monto>0){
        try { await window.firebaseBillingApi.abonarFactura(fx.facturaId, fx.monto); } catch(e){ console.warn('No se pudo abonar factura', fx.facturaId, e); }
      }
    }
    return ref.id;
  },
  
  // Maquinas
  async createMaquina(data){
    const ref = col(collectionsMap.maquinas).doc();
    const payload = { nombre: data.nombre||'SIN NOMBRE', contadores: Array.isArray(data.contadores)? JSON.parse(JSON.stringify(data.contadores)) : [], createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    await ref.set(payload);
    auditLog && auditLog('create','maquina', ref.id, {});
    return ref.id;
  },
  async updateMaquina(id, data){
    await col(collectionsMap.maquinas).doc(id).set({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    auditLog && auditLog('update','maquina', id, Object.keys(data));
  },
  async deleteMaquina(id){ await col(collectionsMap.maquinas).doc(id).set({ estatus:'Inactiva', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('disable','maquina', id, { estatus:'Inactiva' }); }
  ,
  // ==============================
  // Aprobaciones administrativas
  // ==============================
  /** Crea una solicitud de aprobación administrativa. */
  async createAdminApprovalRequest(data){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const uid = window.auth?.currentUser?.uid || null;
    const usuario = window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null;
    const tipo = String(data?.tipo||'').toUpperCase();
    if(!tipo) throw new Error('tipo requerido');
    const payload = deepClean({
      tipo, // e.g. 'CANCELAR_VENTA'
      estado: 'PENDIENTE',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      fecha: getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City'),
      createdBy: uid,
      usuario,
      ventaId: data?.ventaId || null,
      ventaFolio: data?.ventaFolio || null,
      motivo: data?.motivo || null,
      meta: data?.meta || null
    });
    const ref = col(collectionsMap.adminApprovals).doc();
    await ref.set(payload);
    auditLog && auditLog('create','admin_approval', ref.id, { tipo: payload.tipo });
    return ref.id;
  },
  /** Resuelve una aprobación: 'APROBAR' o 'RECHAZAR'. Si se aprueba cancelar venta, ejecuta la acción. */
  async resolveAdminApproval(id, accion){
    if(!id) throw new Error('id requerido');
    const acc = String(accion||'').toUpperCase();
    if(!acc || (acc!=='APROBAR' && acc!=='RECHAZAR')) throw new Error('acción inválida');
    const docRef = col(collectionsMap.adminApprovals).doc(String(id));
    await window.db.runTransaction(async (tx)=>{
      const snap = await tx.get(docRef);
      if(!snap.exists) throw new Error('Solicitud no existe');
      const d = snap.data();
      if(d.estado !== 'PENDIENTE') return; // idempotente
      const now = firebase.firestore.FieldValue.serverTimestamp();
      tx.update(docRef, { estado: (acc==='APROBAR'?'APROBADO':'RECHAZADO'), resolvedAt: now, updatedAt: now, resolvedBy: window.auth?.currentUser?.uid||null });
    });
    // Ejecutar efecto fuera de la transacción para no anidar
    if(accion && String(accion).toUpperCase()==='APROBAR'){
      try{
        const resSnap = await docRef.get();
        if(resSnap.exists){
          const d = resSnap.data();
          if(d.tipo === 'CANCELAR_VENTA' && d.ventaId){
            try { await window.firebaseSalesApi.cancelVenta(d.ventaId, d.motivo||''); } catch(e){ console.warn('No se pudo cancelar venta tras aprobación', e); }
          }
        }
      }catch(_e){}
    }
    auditLog && auditLog('update','admin_approval', id, { accion });
  },
  /** Lista pendientes (para una UI de admin). */
  async listPendingApprovals(limit=50){
    const q = await col(collectionsMap.adminApprovals).where('estado','==','PENDIENTE').orderBy('createdAt','desc').limit(limit).get();
    return q.docs.map(d=>({ id:d.id, ...d.data() }));
  },
  // ==============================
  // [removed] Aprobaciones de Diseño (Tokens)
  // ==============================
  /** [removed] Crea un token de aprobación de diseño y lo persiste. */
  async createDesignApprovalToken(data={}){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    function randomToken(len=32){
      const arr = new Uint8Array(len);
      if(window.crypto?.getRandomValues) window.crypto.getRandomValues(arr); else for(let i=0;i<len;i++) arr[i] = (Math.random()*256)|0;
      return Array.from(arr).map(b=>('0'+b.toString(16)).slice(-2)).join('');
    }
    const token = randomToken(24); // 48 hex chars
    const ref = col(collectionsMap.approvalTokens).doc(token);
    const nowIso = new Date().toISOString();
    const payload = {
      token,
      ventaId: data.ventaId || data.pedidoId || null,
      version: typeof data.version==='number'? data.version : parseInt(data.version||'1',10)||1,
      clienteId: data.clienteId || null,
      clienteNombre: data.clienteNombre || data.cliente || null,
      comentario: data.comentario || '',
      status: 'PENDIENTE',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      sentAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAtIso: nowIso,
      sentAtIso: nowIso
    };
    await ref.set(payload);
    // Evento inicial
    try { await col(collectionsMap.approvalEvents).add({ token, action:'CREATED', ts: firebase.firestore.FieldValue.serverTimestamp(), fecha: nowIso.slice(0,10) }); } catch(_e){}
    auditLog && auditLog('create','design_token', token, { ventaId: payload.ventaId, version: payload.version });
    return token;
  },
  /** [removed] Marca un token como APROBADO o RECHAZADO. */
  async markDesignToken(token, action){
    if(!token) throw new Error('token requerido');
  // [removed]
    const ref = col(collectionsMap.approvalTokens).doc(token);
    await window.db.runTransaction(async tx=>{
      const snap = await tx.get(ref);
      if(!snap.exists) throw new Error('Token no existe');
      const d = snap.data();
      if(d.status === action) return; // idempotente
      if(d.status !== 'PENDIENTE') return; // Ya resuelto (evitar cambiar)
      tx.update(ref, {
        status: action,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
        resolvedAtIso: new Date().toISOString()
      });
    });
    try { await col(collectionsMap.approvalEvents).add({ token, action, ts: firebase.firestore.FieldValue.serverTimestamp(), fecha: new Date().toISOString().slice(0,10) }); } catch(_e){}
    auditLog && auditLog('update','design_token', token, { action });
  }
};

// --- API Ventas (con parcialidades) ---
window.firebaseSalesApi = {
  // Normaliza método (ventas) a etiqueta usada en 'caja.metodo'
  _toCajaMetodoLabel(mp){
    const m = String(mp||'').toUpperCase();
    if(m==='EFECTIVO') return 'Efectivo';
    if(m==='TARJETA') return 'Tarjeta';
    if(m==='TRANSFERENCIA') return 'Depósitos'; // en caja legacy se usa 'Depósitos'
    if(m==='CHEQUE' || m==='CHEQUES') return 'Cheques';
    return null;
  },
  /**
   * Crea una venta con items y pago inicial (parcialidades)
   * params: { clienteId, clienteNombre, items:[{productoId, descripcion, cantidad, precio, costoUnit}], pagoInicial }
   */
  async createVenta(data){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    let __stage = 'START';
    try{
      const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
      // Resolver sucursal del usuario autenticado (fallback cuando no se envía en data)
      let _userSucursal = undefined;
      try{
        const us = Array.isArray(window.usuarios) ? window.usuarios : [];
        const u = uid ? us.find(x=> String(x.id||x._docId)===String(uid)) : null;
        const s = (u && typeof u.sucursal==='string' && u.sucursal.trim()) ? u.sucursal.trim() : '';
        _userSucursal = s || undefined;
      }catch(_e){ _userSucursal = undefined; }
      // Resolver nombre legible del usuario que atiende (desde input #usuarioNombre o perfil auth)
      let usuarioVentaNombre = null;
      try{
        const el = (typeof document!=='undefined') ? document.getElementById('usuarioNombre') : null;
        const fromInput = el && el.value ? String(el.value).trim() : '';
        const fromAuth = (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || '') || '';
        usuarioVentaNombre = (fromInput || fromAuth || '').trim() || null;
      }catch(_e){ usuarioVentaNombre = null; }
  const { clienteId, clienteNombre, items=[], pagoInicial:rawPagoInicial=0, disenoStatus, metodoPago, nota, cardRef, mixedCardRef, transferRef, pagoTipo, idemKey } = data;
      // Clamp de pagoInicial para que nunca exceda el total calculado luego (se recalcula tras subtotal). Se ajusta después, aquí solo pre-saneamos tipo.
      let pagoInicial = Number(rawPagoInicial)||0;
      if(!Number.isFinite(pagoInicial) || pagoInicial<0) pagoInicial = 0;
      if(!clienteId) throw new Error('clienteId requerido');
      if(!items.length) throw new Error('items vacío');
    // Backend safety-net: resolve missing productoId from description/code when possible
    // This makes sales contabilize stock even if the frontend didn't bind productoId (e.g., catalog not yet loaded in memory)
    __stage = 'RESOLVE_ITEMS';
    const normStr = (s)=>{
      try { return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
      catch(_e){ return String(s||'').toLowerCase().replace(/\s+/g,' ').trim(); }
    };
    const normalizeCode8 = (raw)=>{
      const digits = String(raw||'').replace(/\D+/g,'');
      if(!digits) return '';
      const last8 = digits.slice(-8);
      return last8.padStart(8,'0');
    };
    const stripDecorations = (desc)=>{
      let base = String(desc||'');
      // Remove extras suffix like:  " + [Extra A, Extra B]"
      base = base.replace(/\s*\+\s*\[[^\]]*\]\s*$/,'');
      // Remove trailing parenthetical, commonly used for area notes: " (1.00x1.00 m = 1.00 m²)" or " (1.00 m lineales; alto 1.50 m)"
      base = base.replace(/\s*\([^)]*\)\s*$/,'');
      return base.trim();
    };
    for(let i=0;i<items.length;i++){
      const it = items[i];
      if(it && !it.productoId){
        try{
          const desc = String(it.descripcion||'').trim();
          if(!desc){ continue; }
          // 1) Try resolve by 8-digit code found in description
          const code8 = normalizeCode8(desc);
          if(code8){
            let foundId = null;
            try{
              const q1 = await col(collectionsMap.productos).where('codigoInterno','==', code8).limit(1).get();
              if(!q1.empty){ foundId = q1.docs[0].id; }
              else {
                const q2 = await col(collectionsMap.productos).where('codigo','==', code8).limit(1).get();
                if(!q2.empty){ foundId = q2.docs[0].id; }
              }
            }catch(_e){}
            if(foundId){ it.productoId = foundId; continue; }
          }
          // 2) Try resolve by unique normalized description
          const baseName = stripDecorations(desc);
          const n = normStr(baseName);
          if(n){
            try{
              const qr = await col(collectionsMap.productos).where('descripcionLower','==', n).limit(2).get();
              if(!qr.empty && qr.size===1){ it.productoId = qr.docs[0].id; continue; }
            }catch(_e){}
          }
        }catch(_e){ /* ignore resolution error */ }
      }
    }
    // ==============================
    // Idempotencia Hash (anti-doble click / reintentos red)
    // ==============================
    // Genera un hash determinista del contenido esencial de la venta (cliente + items normalizados + total estimado)
    // y crea (o reusa) un lock rápido en 'ventas_hash'. Si ya existe una venta final asociada, regresa su ID.
    // Ventana de reuso: 2 minutos (para evitar colisiones de ventas legítimas iguales más tarde)
    __stage = 'HASH_LOCK';
    let ventaHash = null;
    try {
      const hashItems = items.map(it=>({
        d: String(it.descripcion||'').trim().slice(0,120),
        p: Number(it.precio||0)||0,
        c: Number(it.cantidad||0)||0,
        pid: it.productoId||null
      }));
      const hashPayload = {
        clienteId: data?.clienteId||null,
        items: hashItems,
        pagoInicial: Number(data?.pagoInicial||0)||0,
        tsBucket: Math.floor(Date.now()/ (2*60*1000)) // bucket de 2 minutos para reducir colisiones futuras y permitir ventas idénticas más tarde
      };
      const raw = JSON.stringify(hashPayload);
      async function sha256(str){
        if(window.crypto?.subtle){
          const enc = new TextEncoder().encode(str);
            const buf = await window.crypto.subtle.digest('SHA-256', enc);
            return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
        } else {
          // Fallback hash simple (no criptográfico) – suficiente para deduplicación visual
          let h = 0; for(let i=0;i<str.length;i++){ h = (Math.imul(31,h) + str.charCodeAt(i))|0; } return 'fh_'+(h>>>0).toString(16);
        }
      }
      ventaHash = await sha256(raw);
      const hashRef = col('ventas_hash').doc(ventaHash);
      let existingVentaId = null;
      await window.db.runTransaction(async tx => {
        const snap = await tx.get(hashRef);
        if(snap.exists){
          const d = snap.data()||{};
          // Si ya tiene ventaId final y se creó hace <=2min, reusar
          if(d.ventaId && d.createdAtMs && (Date.now() - d.createdAtMs) < (2*60*1000)){
            existingVentaId = d.ventaId;
            return;
          }
          // Si es un lock provisional sin ventaId (posible retry concurrente), continuar; no sobre-escribimos ventaId
          tx.set(hashRef, { lastTryAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        } else {
          tx.set(hashRef, { createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdAtMs: Date.now(), provisional:true });
        }
      });
      if(existingVentaId){
        return { id: existingVentaId, ventaId: existingVentaId, stockWarnings: [] }; // Idempotente: ya existe venta equivalente muy reciente
      }
    } catch(hashErr){
      console.warn('[Ventas][IdemHash] fallo hash lock (continuando)', hashErr?.message||hashErr);
    }
    // Validar stock disponible (lecturas previas) – minimizar sobreselling.
    // Tolerante: si el producto no existe o no es de inventario (inventario!='SI'), no bloquear la venta ni descontar stock.
  const prodNeeds = {};
  const invAllowed = {}; // pid -> true si se valida y descuenta inventario
  let stockWarnings = []; // recopila advertencias de stock insuficiente (productos base y BOM)
    items.filter(it=> it.productoId && it.cantidad>0).forEach(it=>{ prodNeeds[it.productoId] = (prodNeeds[it.productoId]||0) + it.cantidad; });
    // Cache de datos de producto para usar receta/BOM y otros metadatos
    const productDataMap = {};
    for(const pid of Object.keys(prodNeeds)){
      try{
        const pSnap = await col(collectionsMap.productos).doc(pid).get();
        if(!pSnap.exists){
          console.warn('[Ventas] Producto no encontrado, omitido de inventario:', pid);
          invAllowed[pid] = false; // no validar ni descontar
          continue;
        }
        const pdata = pSnap.data()||{};
        productDataMap[pid] = pdata;
        // POS default: manejar inventario a menos que esté marcado explícitamente como 'NO'
        const manejaInv = String(pdata.inventario||'').toUpperCase() !== 'NO';
        if(!manejaInv){ invAllowed[pid] = false; continue; }
        const ex = typeof pdata.existencias === 'number' ? pdata.existencias : 0;
        if(ex < prodNeeds[pid]){
          // No bloquear: registrar advertencia y AÚN ASÍ descontar (permitir inventario negativo)
          invAllowed[pid] = true;
          try{
            stockWarnings.push({ productoId: pid, descripcion: pdata.descripcion||pid, existencias: ex, requerido: prodNeeds[pid] });
          }catch(_w){}
          // continuar con invAllowed=true
        }
        invAllowed[pid] = true;
      }catch(e){
        // Ante error de red/permiso, ser conservador: permitir venta pero no ajustar inventario
        console.warn('[Ventas] Error validando inventario de', pid, e?.message||e);
        invAllowed[pid] = false;
      }
    }
    // Pre-checar BOM (receta) para advertencias de stock de componentes
    // 1) Agregar necesidades de componentes de todos los items (solo INSUMO)
    const bomNeeds = {}; // componenteId -> cantidad total requerida
    try{
      for(const it of items){
        if(!it || !it.productoId || !(it.cantidad>0)) continue;
        const pdata = productDataMap[it.productoId] || null;
        const receta = Array.isArray(pdata?.receta) ? pdata.receta : null;
        if(!receta) continue;
        for(const comp of receta){
          if(!comp) continue;
          const compPid = String(comp.productoId||comp.insumoId||comp.id||'').trim();
          if(!compPid) continue;
          const perUnit = Number(comp.cantidadPorUnidad||comp.cantidad||0);
          if(!(perUnit>0)) continue;
          const tipo = String(comp.tipo||'INSUMO').toUpperCase();
          if(tipo === 'CONSUMIBLE') continue; // consumibles no chequean existencias
          const totalComp = perUnit * Number(it.cantidad||0);
          bomNeeds[compPid] = (bomNeeds[compPid]||0) + totalComp;
        }
      }
      // 2) Leer existencias de componentes y generar advertencias si faltan
      for(const compPid of Object.keys(bomNeeds)){
        try{
          const csnap = await col(collectionsMap.productos).doc(compPid).get();
          if(!csnap.exists) continue;
          const cd = csnap.data()||{};
          const manejaInv = String(cd.inventario||'').toUpperCase() !== 'NO';
          if(!manejaInv) continue;
          const ex = typeof cd.existencias==='number' ? cd.existencias : 0;
          const req = Number(bomNeeds[compPid]||0);
          if(ex < req){
            stockWarnings.push({ scope:'BOM', productoId: compPid, descripcion: cd.descripcion||compPid, existencias: ex, requerido: req });
          }
        }catch(_ew){ /* tolerante */ }
      }
    }catch(_e){ /* silencioso */ }
    // Optional idempotency guard: if idemKey provided, ensure we create only once
  __stage = 'IDEMPOTENCY';
  const idemPath = idemKey ? col('counters').doc('ventas_idem').collection('locks').doc(String(idemKey)) : null;
    if(idemPath){
      let resolvedVentaId = null;
      try{
        await window.db.runTransaction(async(tx)=>{
          const s = await tx.get(idemPath);
          if(s.exists){
            const d = s.data()||{};
            if(d.ventaId){ resolvedVentaId = d.ventaId; return; }
            // If another client claimed, just proceed but we won't duplicate after commit due to post-write set
            tx.set(idemPath, { claimed: true, lastTryAt: firebase.firestore.FieldValue.serverTimestamp(), clientUid: uid||null }, { merge:true });
          } else {
            tx.set(idemPath, { claimed: true, claimedAt: firebase.firestore.FieldValue.serverTimestamp(), clientUid: uid||null });
          }
        });
      }catch(e){
        console.warn('[Ventas] Idempotency lock skipped (rules/auth?):', e && (e.code||e.message||e));
      }
      if(resolvedVentaId){
        // If the resolved venta was deleted manually, ignore the lock and proceed to create a new one
        try {
          const vdoc = await col('ventas').doc(String(resolvedVentaId)).get();
          if(vdoc.exists){
            return { id: resolvedVentaId, ventaId: resolvedVentaId, stockWarnings: [] };
          }
        } catch(_e){}
        // Clear ventaId to allow recreation; keep claimed metadata
        try { await idemPath.set({ ventaId: null, resurrectedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); } catch(_e){}
        // Continue normal flow to create a fresh venta
      }
    }
  __stage = 'TOTALS';
    // Sanitize items numbers to avoid NaN/strings breaking writes
    const cleanItems = items.map(it=>{
      const cantidad = Number(it.cantidad||0);
      const precio = Number(it.precio||0);
      const costoUnit = Number(it.costoUnit||0);
      return {
        ...it,
        cantidad: Number.isFinite(cantidad) ? cantidad : 0,
        precio: Number.isFinite(precio) ? precio : 0,
        costoUnit: Number.isFinite(costoUnit) ? costoUnit : 0
      };
    });
    let subtotal = 0; let costoTotal = 0;
    for(const it of cleanItems){ subtotal += (it.cantidad||0)*(it.precio||0); costoTotal += (it.cantidad||0)*(it.costoUnit||0); }
    if(!Number.isFinite(subtotal) || !Number.isFinite(costoTotal)){
      throw new Error('ITEM_NUM_INVALID: totales no numéricos');
    }
    // Ajustar pagoInicial a máximo subtotal (previene pagado > total)
    if(pagoInicial > subtotal){ pagoInicial = subtotal; }
    // Resumen de productos para consulta/filtrado rápido en listados (incluye servicios y m²)
  const productosText = cleanItems
      .map(it => String(it.descripcion||'').trim())
      .filter(Boolean)
      .join(', ');
  const total = Number(subtotal) || 0; // sin impuestos por ahora
  let saldo = total - (Number(pagoInicial)||0);
  if(!Number.isFinite(saldo)) saldo = 0;
  if(saldo < 0) saldo = 0;
    const status = saldo>0 ? 'PENDIENTE' : 'PAGADA';
    // Determinar método de pago a persistir
  let metodoPersist = metodoPago || null;
    if(!metodoPersist){
      metodoPersist = pagoInicial<=0 ? 'POR_COBRAR' : 'EFECTIVO';
    }
  // Tipo de pago: TOTAL, PARCIAL, POR_COBRAR
  let tipoPersist = pagoTipo || (pagoInicial<=0 ? 'POR_COBRAR' : (pagoInicial<total ? 'PARCIAL' : 'TOTAL'));
    // Generar folio secuencial irrepetible: prefijo 'M-' + 5 dígitos, iniciando en 1001
    // Usa counters/ventasFolio.value incrementado en transacción
  __stage = 'FOLIO';
  let folioNum;
    try {
      folioNum = await window.firebaseApi.nextCounter('ventasFolio', 1000); // 1000 -> primer folio 1001
    } catch(e){
      console.warn('[Ventas] Fallback folio (counters no disponible):', e && (e.code||e.message||e));
      // Fallback: usar segundos unix mod 90000 + 10001 para mantener rango 5 dígitos, evitar colisión en sesiones
      const mod = ((Math.floor(Date.now()/1000) % 90000) + 10001);
      folioNum = mod;
    }
    const folio = `M-${String(folioNum).padStart(5,'0')}`;

  const ventaRef = col('ventas').doc();
    const batch = window.db.batch();
  const initialStatusProd = disenoStatus === 'NO_APLICA' ? 'PENDIENTE' : 'PENDIENTE';
  const ventaSucursal = (typeof data?.sucursal === 'string' && data.sucursal.trim()) ? data.sucursal.trim() : (_userSucursal || undefined);
  // Resolver Caja asociada a esta venta (desde el usuario actual y sucursal coincidente)
  let ventaCajaId = undefined; let ventaCaja = undefined;
  try{
    const us = Array.isArray(window.usuarios) ? window.usuarios : [];
    const me = uid ? us.find(x=> String(x.id||x._docId)===String(uid)) : null;
    const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
    const sucMatch = !ventaSucursal || !me?.sucursal || String(me.sucursal).toLowerCase()===String(ventaSucursal).toLowerCase();
    if(active && sucMatch){ if(me?.caja) ventaCaja = String(me.caja); if(me?.cajaId) ventaCajaId = String(me.cajaId); }
  }catch(_e){ ventaCajaId = undefined; ventaCaja = undefined; }
  // Validar que la caja siga existiendo y esté activa en el catálogo; si no, no persistirla
  try{
    if(ventaCajaId && Array.isArray(window.cajas)){
      const c = window.cajas.find(x=> String(x.id)===String(ventaCajaId));
      const en = c && String(c.estatus||'Activa').toLowerCase()==='activa';
      if(!c || !en){ ventaCajaId = undefined; ventaCaja = undefined; }
    }
  }catch(_e){}
  const __tz = (window.__FECHA_TZ__ || 'America/Mexico_City');
  const __hoyYmd = getTodayStrTZ(__tz);
  batch.set(ventaRef, deepClean({
      clienteId, clienteNombre,
      fecha: __hoyYmd,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
    turnoId: (window.currentTurnoId||undefined),
      createdBy: uid, // usado para filtrar ventas propias a usuarios no-admin
      createdByName: usuarioVentaNombre || null, // nombre legible de quien atendió
      folio,
      folioNum,
      sucursal: ventaSucursal,
      cajaId: ventaCajaId || undefined,
      caja: ventaCaja || undefined,
      subtotal, total, costoTotal,
      pagoInicial, saldo,
      status,
  // [removed] Estado de diseño inicial por aprobación
      disenoStatus: disenoStatus || null,
      // Estado inicial de producción
      statusProd: initialStatusProd,
      statusProdUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  pagado: pagoInicial, // nuevo campo acumulado
  lastAbonoDate: pagoInicial>0 ? __hoyYmd : null,
      itemsCount: items.length,
  productosText: productosText || null,
  stockWarnings: (stockWarnings && stockWarnings.length ? stockWarnings : null),
  version:1,
  metodoPago: metodoPersist,
  pagoTipo: tipoPersist,
  nota: nota || null,
  // Referencias opcionales cuando aplica
  cardRef: cardRef || null,
  mixedCardRef: mixedCardRef || null,
  transferRef: transferRef || null
      ,ventaHash: ventaHash || null
    }));
    // Items subcollection
  // Acumuladores para aplicar receta (BOM): descuentos de insumos y aumentos de desgaste de consumibles
  const bomInsumoAdjust = {}; // productoId -> cantidad total a descontar
  const bomConsumibleWear = []; // { productoId, unidades }
  cleanItems.forEach(it=>{
      const itemRef = ventaRef.collection('items').doc();
      // Snapshot de receta si existe (para reversión exacta en cancelaciones futuras)
      let recetaSnap = null;
      try{
        const pdata = it.productoId ? (productDataMap[it.productoId]||null) : null;
        const receta = Array.isArray(pdata?.receta) ? pdata.receta : null;
        if(receta && receta.length){
          recetaSnap = receta
            .map(c=>({
              productoId: String(c.productoId||c.insumoId||c.id||'').trim(),
              cantidadPorUnidad: Number(c.cantidadPorUnidad||c.cantidad||0),
              tipo: String(c.tipo||'INSUMO').toUpperCase(),
              wearPorUnidad: Number(c.wearPorUnidad||1)
            }))
            .filter(c=> !!c.productoId && c.cantidadPorUnidad>0);
        }
      }catch(_e){ recetaSnap = null; }
      batch.set(itemRef, {
        descripcion: it.descripcion,
        productoId: it.productoId||null,
        cantidad: it.cantidad,
        precio: it.precio,
        costoUnit: it.costoUnit||0,
        importe: (it.cantidad||0)*(it.precio||0),
        recetaSnap: (recetaSnap && recetaSnap.length? recetaSnap : null)
      });
      // Ajuste stock producto si aplica
      if(it.productoId && invAllowed[it.productoId]){
        const pRef = col(collectionsMap.productos).doc(it.productoId);
        batch.update(pRef, { existencias: firebase.firestore.FieldValue.increment(-(it.cantidad||0)) });
      }
      // Aplicar receta/BOM del producto vendido (si existe). Se espera un arreglo en el documento del producto:
      // receta: [{ productoId: string, cantidadPorUnidad: number, tipo: 'INSUMO'|'CONSUMIBLE', wearPorUnidad?: number }]
      try{
        const pdata = it.productoId ? (productDataMap[it.productoId]||null) : null;
        const receta = Array.isArray(pdata?.receta) ? pdata.receta : null;
        if(receta && it.cantidad>0){
          for(const comp of receta){
            if(!comp) continue;
            const compPid = String(comp.productoId||comp.insumoId||comp.id||'').trim();
            if(!compPid) continue;
            const perUnit = Number(comp.cantidadPorUnidad||comp.cantidad||0);
            if(!(perUnit>0)) continue;
            const totalComp = perUnit * Number(it.cantidad||0);
            const tipo = String(comp.tipo||'INSUMO').toUpperCase();
            if(tipo === 'CONSUMIBLE'){
              const wear = Number(comp.wearPorUnidad||1);
              const unidades = totalComp * (wear>0? wear:1);
              if(unidades>0){ bomConsumibleWear.push({ productoId: compPid, unidades, origenProductoId: it.productoId||null, origenProductoDesc: it.descripcion||null }); }
            } else {
              // INSUMO (default): descontar existencias
              bomInsumoAdjust[compPid] = (bomInsumoAdjust[compPid]||0) + totalComp;
            }
          }
        }
      }catch(_e){ /* receta opcional / tolerante */ }
    });
    // Aplicar descuentos de insumo acumulados por BOM en el mismo batch
    try{
      for(const pid of Object.keys(bomInsumoAdjust)){
        const qty = Number(bomInsumoAdjust[pid]||0);
        if(qty>0){
          const ref = col(collectionsMap.productos).doc(String(pid));
          batch.update(ref, { existencias: firebase.firestore.FieldValue.increment(-qty) });
        }
      }
    }catch(_e){ /* no bloquear venta por errores de receta */ }
    // Cliente: totalCompras, ultimaCompra, saldo (si aplica)
    const cRef = col(collectionsMap.clientes).doc(clienteId);
    batch.set(cRef, {
      totalCompras: firebase.firestore.FieldValue.increment(total),
      ultimaCompra: new Date().toISOString().slice(0,10),
      saldo: firebase.firestore.FieldValue.increment(saldo)
    }, { merge:true });
    // Movimiento caja si hay pagoInicial
    if(pagoInicial>0){
      const cajaRef = col(collectionsMap.caja).doc();
      const metodoCaja = this._toCajaMetodoLabel(metodoPersist);
      const usuarioName = (usuarioVentaNombre || window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
      // Generate 8-digit caja id for this movement
      let id8 = null; try { id8 = await window.firebaseApi.getNextCajaId8(); } catch(_e){}
  const cajaSucursal = (typeof data?.sucursal === 'string' && data.sucursal.trim()) ? data.sucursal.trim() : (ventaSucursal || _userSucursal || undefined);
      // Resolve caja from current user if active and sucursal matches
  let cajaName = undefined;
  let cajaId = undefined;
      try{
        const us = Array.isArray(window.usuarios) ? window.usuarios : [];
        const me = uid ? us.find(x=> String(x.id||x._docId)===String(uid)) : null;
        const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
        const sucMatch = !cajaSucursal || !me?.sucursal || String(me.sucursal).toLowerCase()===String(cajaSucursal).toLowerCase();
    if(active && sucMatch){ if(me?.caja) cajaName = String(me.caja); if(me?.cajaId) cajaId = String(me.cajaId); }
      }catch(_e){ cajaName = undefined; }
      // Diferenciar tipo de movimiento: si la venta queda totalmente pagada => VENTA_[METODO]; si solo anticipo => VENTA_ANTICIPO
      const isTotal = saldo===0;
      let movTipo;
      if(isTotal){
        // Mapear a VENTA_METODO si hay metodoPersist, si no VENTA_EFECTIVO como fallback
        const mUpper = String(metodoPersist||'EFECTIVO').toUpperCase();
        movTipo = `VENTA_${mUpper}`; // VENTA_EFECTIVO / VENTA_TARJETA / etc.
      } else {
        movTipo = 'VENTA_ANTICIPO';
      }
  batch.set(cajaRef, deepClean({
        id8: id8 || null,
    fecha: __hoyYmd,
  tipo: movTipo,
        monto: pagoInicial,
        ventaId: ventaRef.id,
        ventaFolio: folio,
  descripcion: isTotal ? `Cobro Venta ${folio} (${clienteNombre||''})` : `Anticipo Venta ${folio} (${clienteNombre||''})`,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
    turnoId: (window.currentTurnoId||undefined),
        userId: uid,
        usuario: usuarioName || undefined,
  metodoPago: metodoPersist,
  metodo: metodoCaja || undefined,
  pagoTipo: tipoPersist,
  ref: (cardRef||mixedCardRef||transferRef)||null,
  sucursal: cajaSucursal,
  cajaId: cajaId || undefined,
  caja: cajaName || undefined
    }));
    }
    __stage = 'COMMIT';
    try{
      await batch.commit();
    }catch(e){
      console.error('[Ventas] commit fallo:', e && (e.code||e.message||e));
      throw e;
    }
    // Post-commit: aumentar desgaste de consumibles por BOM (no bloqueante)
    try{
      if(Array.isArray(bomConsumibleWear) && bomConsumibleWear.length){
        for(const w of bomConsumibleWear){
          try{
            await window.firebaseApi.incrementarDesgasteConsumible({
              productoId: w.productoId,
              unidades: w.unidades,
              origenProductoId: w.origenProductoId||null,
              origenProductoDesc: w.origenProductoDesc||null,
              origenVentaFolio: folio
            });
          }catch(_we){ console.warn('[Ventas] incrementarDesgasteConsumible fallo para', w.productoId, _we?.message||_we); }
        }
      }
    }catch(_e){ /* continuar flujo */ }
  // Mark idempotency record with resulting ventaId (best-effort)
  try{ if(idemPath){ await idemPath.set({ ventaId: ventaRef.id, resolvedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); } }catch(_e){
    console.warn('[Ventas] No se pudo escribir lock de idempotencia (omitible)');
  }
    // Marcar hash lock con ventaId final (best-effort)
    if(ventaHash){
      try {
        await col('ventas_hash').doc(ventaHash).set({ ventaId: ventaRef.id, provisional:false, finalizedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
      } catch(_eh){ console.warn('[Ventas][IdemHash] no se pudo finalizar hash', _eh?.message||_eh); }
    }
    if(window.auditLog) auditLog('create','venta',ventaRef.id,{ total, saldo, clienteId });
    if(saldo>0){
      // Registrar abono inicial como subcollection abonos si pagoInicial>0
      if(pagoInicial>0){
        await ventaRef.collection('abonos').add({
          monto: pagoInicial,
          ts: firebase.firestore.FieldValue.serverTimestamp(),
          fecha: __hoyYmd,
          userId: uid,
          tipo:'INICIAL',
          pagoTipo: tipoPersist,
          metodoPago: metodoPersist,
          ref: (cardRef||mixedCardRef||transferRef)||null
        });
      }
    } else if(pagoInicial>0){
      // Venta pagada totalmente: registrar abono único
      await ventaRef.collection('abonos').add({
        monto: pagoInicial,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        fecha: __hoyYmd,
        userId: uid,
        tipo:'TOTAL',
        pagoTipo: tipoPersist,
        metodoPago: metodoPersist,
  ref: (cardRef||mixedCardRef||transferRef)||null
      });
    }
    __stage = 'DONE';
    const warningsPayload = Array.isArray(stockWarnings) && stockWarnings.length ? stockWarnings.map(w=>({ ...w })) : [];
    return { id: ventaRef.id, ventaId: ventaRef.id, stockWarnings: warningsPayload };
    }catch(e){
      const msg = e && (e.message||String(e));
      const code = e && (e.code||e.name||'');
      console.error('[Ventas][Debug] stage=', __stage, 'code=', code, 'msg=', msg);
      const err = new Error(`[VENTA:${__stage}] ${msg}`);
      err.code = code; err.stage = __stage; err.original = e;
      throw err;
    }
  },
  /** Abonar parcialidad a una venta existente */
  async abonarVenta(ventaId, monto, opts={}){
    if(monto<=0) throw new Error('Monto inválido');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
    const ventaRef = col('ventas').doc(ventaId);
    // Resolver sucursal del usuario autenticado para default de caja si no se envía en opts
    let _userSucursal = undefined;
    try{
      const us = Array.isArray(window.usuarios) ? window.usuarios : [];
      const u = uid ? us.find(x=> String(x.id||x._docId)===String(uid)) : null;
      const s = (u && typeof u.sucursal==='string' && u.sucursal.trim()) ? u.sucursal.trim() : '';
      _userSucursal = s || undefined;
    }catch(_e){ _userSucursal = undefined; }
  await window.db.runTransaction(async(tx)=>{
      const snap = await tx.get(ventaRef);
      if(!snap.exists) throw new Error('Venta no existe');
      const v = snap.data();
      if((v.saldo||0)<=0) throw new Error('Venta ya saldada');
      const saldoActual = v.saldo||0;
      const esPersonal = !!(opts && opts.personal);
      // Si es personal, solo se permite cubrir costo restante: costoTotal - abonosPersonalesAcumulado
      let costoCap = Number(v.costoTotal||0) - Number(v.abonosPersonalesAcumulado||0);
      if(!Number.isFinite(costoCap)) costoCap = 0;
      costoCap = Math.max(0, costoCap);
      let montoAplicado = Math.min(monto, saldoActual);
      if(esPersonal){
        if(costoCap<=0) throw new Error('No hay costo disponible por cubrir con abono personal.');
        montoAplicado = Math.min(montoAplicado, costoCap);
        if(!(montoAplicado>0)) throw new Error('Monto personal excede el costo disponible.');
      }
      const currentPersonal = Number(v.abonosPersonalesPendientes||0);
      if(esPersonal){
        // No tocar saldo/pagado del cliente ni lastAbonoDate. Sólo acumular pendientes personales.
        const ventaPatch = { abonosPersonalesPendientes: currentPersonal + montoAplicado };
        ventaPatch.abonosPersonalesAcumulado = (Number(v.abonosPersonalesAcumulado||0) + montoAplicado);
        tx.update(ventaRef, ventaPatch);
      } else {
        const nuevoSaldo = Math.max(0, saldoActual - montoAplicado);
        const nuevoPagado = (v.pagado||0) + montoAplicado;
  const ventaPatch = { saldo: nuevoSaldo, pagado: nuevoPagado, status: nuevoSaldo>0 ? 'PENDIENTE':'PAGADA', lastAbonoDate: getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City') };
        tx.update(ventaRef, ventaPatch);
        // Cliente saldo decremento sólo para abonos del cliente (no personales)
        if(v.clienteId){
          const cRef = col(collectionsMap.clientes).doc(v.clienteId);
          tx.set(cRef, { saldo: firebase.firestore.FieldValue.increment(-montoAplicado) }, { merge:true });
        }
      }
      // Caja movimiento
  const cajaRef = col(collectionsMap.caja).doc();
      const metodoPago = opts?.metodoPago || null;
      const metodoCaja = metodoPago ? (window.firebaseSalesApi && window.firebaseSalesApi._toCajaMetodoLabel ? window.firebaseSalesApi._toCajaMetodoLabel(metodoPago) : null) : null;
      const usuarioName = (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
    let id8_abono = null; try { id8_abono = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
  const cajaSucursal = (typeof opts?.sucursal === 'string' && opts.sucursal.trim()) ? opts.sucursal.trim() : (_userSucursal || undefined);
  tx.set(cajaRef, deepClean({
        id8: id8_abono || null,
    fecha: getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City'),
        tipo: esPersonal ? 'VENTA_ABONO_PERSONAL' : 'VENTA_ABONO',
        monto: montoAplicado,
        ventaId: ventaId,
        ventaFolio: v.folio || undefined,
        descripcion: esPersonal ? `Abono personal Venta ${v.folio||ventaId}` : `Abono Venta ${v.folio||ventaId}`,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        userId: uid,
        usuario: usuarioName || undefined,
        metodoPago: metodoPago || null,
        metodo: metodoCaja || null,
        ref: (typeof opts?.ref === 'string' && opts.ref.trim()? opts.ref.trim() : null),
  sucursal: cajaSucursal,
  cajaId: (function(){ try{ const us=Array.isArray(window.usuarios)?window.usuarios:[]; const me=uid? us.find(x=> String(x.id||x._docId)===String(uid)) : null; const active=String(me?.estatus||'Activo').toLowerCase()==='activo'; const sucMatch = !cajaSucursal || !me?.sucursal || String(me.sucursal).toLowerCase()===String(cajaSucursal).toLowerCase(); if(active && sucMatch && me?.cajaId){ return String(me.cajaId); } }catch(_e){} return undefined; })(),
  caja: (function(){ try{ const us=Array.isArray(window.usuarios)?window.usuarios:[]; const me=uid? us.find(x=> String(x.id||x._docId)===String(uid)) : null; const active=String(me?.estatus||'Activo').toLowerCase()==='activo'; const sucMatch = !cajaSucursal || !me?.sucursal || String(me.sucursal).toLowerCase()===String(cajaSucursal).toLowerCase(); if(active && sucMatch && me?.caja){ return String(me.caja); } }catch(_e){} return undefined; })(),
        personal: esPersonal ? true : null
  }));
      // Abono subcollection
      const abonoRef = ventaRef.collection('abonos').doc();
  tx.set(abonoRef, { monto: montoAplicado, ts: firebase.firestore.FieldValue.serverTimestamp(), fecha:getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City'), userId: uid, tipo:'ABONO', metodoPago: metodoPago || null, ref: (typeof opts?.ref === 'string' && opts.ref.trim()? opts.ref.trim() : null), personal: esPersonal ? true : null });
    });
    if(window.auditLog) auditLog('abono','venta',ventaId,{ monto: Math.min(monto, (window.ventas||[]).find(v=>v.id===ventaId)?.saldo||monto) });
  },
  /** Cancelar venta: revierte inventario, ajusta saldos cliente y registra movimiento caja negativo (reembolso) */
  async cancelVenta(ventaId, motivo=''){
    if(!ventaId) throw new Error('ventaId requerido');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
    const ventaRef = col('ventas').doc(ventaId);
    // Obtener items fuera de transacción (consistencia eventual aceptada)
    const itemsSnap = await ventaRef.collection('items').get();
    const items = itemsSnap.docs.map(d=>({ id:d.id, ...d.data() }));
    await window.db.runTransaction(async(tx)=>{
      const vSnap = await tx.get(ventaRef);
      if(!vSnap.exists) throw new Error('Venta no existe');
      const v = vSnap.data();
      if(v.status === 'CANCELADA') throw new Error('Ya cancelada');
      const totalPaid = (v.total||0) - (v.saldo||0);
      // Revertir inventario
      for(const it of items){
        if(it && it.productoId && it.cantidad){
          const pRef = col(collectionsMap.productos).doc(it.productoId);
          const pSnap = await tx.get(pRef);
          if(pSnap.exists){
            tx.update(pRef, { existencias: firebase.firestore.FieldValue.increment(it.cantidad) });
          } else {
            // Producto fue eliminado; omitir el ajuste de existencias para no romper la transacción
          }
        }
      }
      // Revertir efectos de la Receta (BOM) aplicada al crear la venta: devolver insumos y restar desgaste a consumibles
      try{
        // Agregar por componente para minimizar writes
        const bomInsumoRefund = {}; // productoId -> cantidad a devolver
        const bomConsumibleRefund = {}; // productoId -> unidades de desgaste a restar
        // Recorrer items vendidos y preferir recetaSnap almacenada; si no existe, usar receta actual del producto
        for (const it of items){
          if(!it || !it.productoId || !(it.cantidad>0)) continue;
          try{
            let receta = null;
            if(Array.isArray(it.recetaSnap) && it.recetaSnap.length){
              receta = it.recetaSnap;
            } else {
              const parentRef = col(collectionsMap.productos).doc(String(it.productoId));
              const parentSnap = await tx.get(parentRef);
              if(!parentSnap.exists) continue;
              const pdata = parentSnap.data()||{};
              receta = Array.isArray(pdata.receta)? pdata.receta : null;
            }
            if(!receta || !receta.length) continue;
            for(const comp of receta){
              if(!comp) continue;
              const compPid = String(comp.productoId||comp.insumoId||comp.id||'').trim();
              if(!compPid) continue;
              const perUnit = Number(comp.cantidadPorUnidad||comp.cantidad||0);
              if(!(perUnit>0)) continue;
              const totalComp = perUnit * Number(it.cantidad||0);
              const tipo = String(comp.tipo||'INSUMO').toUpperCase();
              if(tipo === 'CONSUMIBLE'){
                const wear = Number(comp.wearPorUnidad||1);
                const unidades = totalComp * (wear>0? wear:1);
                if(unidades>0){ bomConsumibleRefund[compPid] = (bomConsumibleRefund[compPid]||0) + unidades; }
              } else {
                // INSUMO: devolver existencias consumidas por la receta
                bomInsumoRefund[compPid] = (bomInsumoRefund[compPid]||0) + totalComp;
              }
            }
          }catch(_e){ /* receta opcional */ }
        }
        // Aplicar devoluciones de insumos
        for(const pid of Object.keys(bomInsumoRefund)){
          const qty = Number(bomInsumoRefund[pid]||0);
          if(qty>0){
            const ref = col(collectionsMap.productos).doc(String(pid));
            tx.update(ref, { existencias: firebase.firestore.FieldValue.increment(qty) });
          }
        }
        // Aplicar reversión de desgaste a consumibles y registrar historial negativo
        const tz = window.__FECHA_TZ__ || 'America/Mexico_City';
        const fechaHoy = getTodayStrTZ(tz);
        for(const pid of Object.keys(bomConsumibleRefund)){
          const unidades = Number(bomConsumibleRefund[pid]||0);
          if(unidades>0){
            const ref = col(collectionsMap.productos).doc(String(pid));
            // Clamp a >= 0 en transacción
            try{
              const ps = await tx.get(ref);
              if(ps.exists){
                const prev = Number(ps.data().consumibleWearActual||0);
                const next = Math.max(0, prev - unidades);
                tx.update(ref, { consumibleWearActual: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              } else {
                tx.update(ref, { consumibleWearActual: firebase.firestore.FieldValue.increment(-unidades), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              }
            }catch(_eClamp){ tx.update(ref, { consumibleWearActual: firebase.firestore.FieldValue.increment(-unidades), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); }
            // Historial: guardar entrada con impresiones negativas para trazar la reversión por cancelación
            const histRef = col(collectionsMap.consumiblesHistorial).doc();
            tx.set(histRef, deepClean({
              productoId: String(pid),
              // productoDesc se rellenará best-effort fuera de transacción por consultas; aquí lo omitimos
              modo: 'impresiones',
              impresiones: -unidades,
              fecha: fechaHoy,
              ventaFolio: v.folio || null,
              motivo: 'reversion_cancelacion_venta',
              ts: firebase.firestore.FieldValue.serverTimestamp(),
              createdBy: uid || null
            }));
          }
        }
      }catch(_e){ /* tolerante: no bloquear cancelación si falla reversión de receta */ }
      // Ajustar cliente (restar totalCompras y saldo pendiente)
      if(v.clienteId){
        tx.set(col(collectionsMap.clientes).doc(v.clienteId), {
          totalCompras: firebase.firestore.FieldValue.increment(-(v.total||0)),
          saldo: (v.saldo||0)>0 ? firebase.firestore.FieldValue.increment(-(v.saldo||0)) : firebase.firestore.FieldValue.increment(0)
        }, { merge:true });
      }
      // Movimiento caja negativo (reembolso de lo pagado)
      if(totalPaid>0){
        const cajaRef = col(collectionsMap.caja).doc();
        const usuarioName = (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
        let id8 = null; try { id8 = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
        const cajaSucursal = (typeof v?.sucursal === 'string' && v.sucursal.trim()) ? v.sucursal.trim() : undefined;
        // Caja name from current user if available
        let cajaName = undefined; let cajaId = undefined; try{
          const us = Array.isArray(window.usuarios) ? window.usuarios : [];
          const me = window.auth?.currentUser?.uid ? us.find(x=> String(x.id||x._docId)===String(window.auth.currentUser.uid)) : null;
          const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
          const sucMatch = !cajaSucursal || !me?.sucursal || String(me.sucursal).toLowerCase()===String(cajaSucursal).toLowerCase();
          if(active && sucMatch){ if(me?.caja) cajaName = String(me.caja); if(me?.cajaId) cajaId = String(me.cajaId); }
        }catch(_e){}
  tx.set(cajaRef, deepClean({
          id8: id8 || null,
    fecha: getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City'),
          tipo: 'VENTA_CANCELACION',
          monto: -totalPaid,
          ventaId: ventaId,
          ventaFolio: v.folio || undefined,
          descripcion: `Reembolso cancelación Venta ${v.folio||ventaId}`,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          userId: uid,
          usuario: usuarioName || undefined,
          sucursal: cajaSucursal,
          cajaId: cajaId || undefined,
          caja: cajaName || undefined
  }));
      }
      // Para cumplir reglas: incluir pagado para que pagado + saldo == total
      tx.update(ventaRef, {
        status:'CANCELADA',
        cancelAt: firebase.firestore.FieldValue.serverTimestamp(),
        cancelBy: uid,
        cancelMotivo: motivo,
        saldo:0,
        pagado: totalPaid,
        totalPaid: totalPaid,
  lastAbonoDate: getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City')
      });
    });
    if(window.auditLog) auditLog('cancel','venta',ventaId,{ motivo });
  }
  ,
  /** Actualiza status de producción de una venta y registra historial
   * @param {string} ventaId
   * @param {string} nextStatus
   * @param {{ metodoCobro?: 'EFECTIVO'|'TARJETA'|'TRANSFERENCIA'|'CHEQUE' }} [opts]
   */
  async updateVentaProductionStatus(ventaId, nextStatus, opts={}){
    if(!ventaId) throw new Error('ventaId requerido');
    if(!nextStatus) throw new Error('nextStatus requerido');
    const ventaRef = col('ventas').doc(ventaId);
    await window.db.runTransaction(async tx=>{
      const snap = await tx.get(ventaRef);
      if(!snap.exists) throw new Error('Venta no existe');
      const v = snap.data();
  const current = v.statusProd || 'PENDIENTE';
      if(current === nextStatus) return; // nada que hacer
      // Guardar status principal y timestamp
      const baseUpdate = { statusProd: nextStatus, statusProdUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      // Si se marca como ENTREGADO, registrar fecha de entrega
      if(nextStatus === 'ENTREGADO') baseUpdate.entregadoAt = firebase.firestore.FieldValue.serverTimestamp();
      tx.update(ventaRef, baseUpdate);
      // Si se marca ENTREGADO: registrar el cobro del saldo pendiente en caja como VENTA_[METODO]
  if(nextStatus === 'ENTREGADO'){
        const uid = window.auth?.currentUser?.uid || null;
    const hoy = getTodayStrTZ(window.__FECHA_TZ__ || 'America/Mexico_City');
  const usuarioName = (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
        const saldoPend = Number(v.saldo||0);
        const totalVenta = Number(v.total||0);
        // Actualizar venta como saldada (pagado += saldoPend)
        const nuevoPagado = (Number(v.pagado||0) + saldoPend);
        tx.update(ventaRef, { saldo: 0, pagado: nuevoPagado, status: 'PAGADA', lastAbonoDate: hoy });
        // Ajustar cliente saldo (solo lo que estuviera pendiente)
        if(v.clienteId && saldoPend>0){
          const cRef = col(collectionsMap.clientes).doc(v.clienteId);
          tx.set(cRef, { saldo: firebase.firestore.FieldValue.increment(-saldoPend) }, { merge:true });
        }
        // Movimiento caja: registrar solo el saldo pendiente como VENTA_[METODO] (por defecto EFECTIVO)
  if(saldoPend>0){
          const cajaRef = col(collectionsMap.caja).doc();
          const metodoCobro = (typeof opts?.metodoCobro==='string' && opts.metodoCobro) ? String(opts.metodoCobro).toUpperCase() : 'EFECTIVO';
          const tipoVenta = `VENTA_${metodoCobro}`; // VENTA_EFECTIVO, VENTA_TARJETA, etc.
          let id8_cobro = null; try { id8_cobro = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
          const cajaSucursal2 = (typeof v?.sucursal === 'string' && v.sucursal.trim()) ? v.sucursal.trim() : undefined;
          let cajaName2 = undefined; let cajaId2 = undefined; try{
            const us = Array.isArray(window.usuarios) ? window.usuarios : [];
            const me = window.auth?.currentUser?.uid ? us.find(x=> String(x.id||x._docId)===String(window.auth.currentUser.uid)) : null;
            const active = String(me?.estatus||'Activo').toLowerCase()==='activo';
            const sucMatch = !cajaSucursal2 || !me?.sucursal || String(me.sucursal).toLowerCase()===String(cajaSucursal2).toLowerCase();
            if(active && sucMatch){ if(me?.caja) cajaName2 = String(me.caja); if(me?.cajaId) cajaId2 = String(me.cajaId); }
          }catch(_e){}
          tx.set(cajaRef, deepClean({
            id8: id8_cobro || null,
            fecha: hoy,
            tipo: tipoVenta,
            monto: saldoPend,
            ventaId: ventaId,
            ventaFolio: v.folio || undefined,
            descripcion: `Cobro saldo Venta ${v.folio||ventaId}`,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            userId: uid,
            usuario: usuarioName || undefined,
            metodoPago: metodoCobro,
            metodo: (window.firebaseSalesApi && window.firebaseSalesApi._toCajaMetodoLabel ? window.firebaseSalesApi._toCajaMetodoLabel(metodoCobro) : 'Efectivo'),
            sucursal: cajaSucursal2,
            cajaId: cajaId2 || undefined,
            caja: cajaName2 || undefined
          }));
        }
        // Segundo: devolver abonos personales pendientes íntegramente
        const pendientePersonal = Number(v.abonosPersonalesPendientes||0);
        if(pendientePersonal > 0){
          tx.update(ventaRef, { abonosPersonalesPendientes: 0 });
          const devRef = col(collectionsMap.caja).doc();
          let id8_dev = null; try { id8_dev = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
          const cajaSucursal3 = (typeof v?.sucursal === 'string' && v.sucursal.trim()) ? v.sucursal.trim() : undefined;
          tx.set(devRef, deepClean({
            id8: id8_dev || null,
            fecha: hoy,
            tipo: 'DEVOLUCION_ABONO_PERSONAL',
            monto: pendientePersonal,
            ventaId: ventaId,
            ventaFolio: v.folio || undefined,
            descripcion: `Devolución abono personal Venta ${v.folio||ventaId}`,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            userId: uid,
            usuario: usuarioName || undefined,
            metodoPago: 'EFECTIVO',
            metodo: (window.firebaseSalesApi && window.firebaseSalesApi._toCajaMetodoLabel ? window.firebaseSalesApi._toCajaMetodoLabel('EFECTIVO') : 'Efectivo'),
            sucursal: cajaSucursal3,
            cajaId: (function(){ try{ const us=Array.isArray(window.usuarios)?window.usuarios:[]; const me=window.auth?.currentUser?.uid? us.find(x=> String(x.id||x._docId)===String(window.auth.currentUser.uid)) : null; const active=String(me?.estatus||'Activo').toLowerCase()==='activo'; if(active && me?.cajaId){ return String(me.cajaId); } }catch(_e){} return undefined; })(),
            caja: (function(){ try{ const us=Array.isArray(window.usuarios)?window.usuarios:[]; const me=window.auth?.currentUser?.uid? us.find(x=> String(x.id||x._docId)===String(window.auth.currentUser.uid)) : null; const active=String(me?.estatus||'Activo').toLowerCase()==='activo'; if(active && me?.caja){ return String(me.caja); } }catch(_e){} return undefined; })()
          }));
        }
      }
      // Historial en subcollection
      const histRef = ventaRef.collection('produccion_hist').doc();
      tx.set(histRef, { de: current, a: nextStatus, ts: firebase.firestore.FieldValue.serverTimestamp(), fecha: new Date().toISOString().slice(0,10), userId: window.auth?.currentUser?.uid||null });
    });
    auditLog && auditLog('update','venta_statusProd', ventaId, { nextStatus });
  }
  ,
  /** Aplica la receta (BOM) de un producto para fabricar a stock sin crear venta.
   * Disminuye insumos e incrementa desgaste de consumibles proporcionales a cantidad.
   * @param {{ productoId:string, cantidad:number }} data
   */
  async fabricarAStock({ productoId, cantidad }){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const pid = String(productoId||'').trim();
    const qty = Number(cantidad||0);
    if(!pid || !(qty>0)) throw new Error('Datos inválidos');
    // Leer receta del producto
    const pSnap = await col(collectionsMap.productos).doc(pid).get();
    if(!pSnap.exists) throw new Error('Producto no existe');
    const pdata = pSnap.data()||{};
    const receta = Array.isArray(pdata.receta)? pdata.receta: null;
    if(!receta || !receta.length) return true; // nada que aplicar
    const insumoDec = {}; const wearList = [];
    for(const comp of receta){
      if(!comp) continue; const cpid = String(comp.productoId||comp.insumoId||comp.id||'').trim(); if(!cpid) continue;
      const perUnit = Number(comp.cantidadPorUnidad||comp.cantidad||0); if(!(perUnit>0)) continue;
      const totalComp = perUnit * qty; const tipo = String(comp.tipo||'INSUMO').toUpperCase();
      if(tipo==='CONSUMIBLE'){
        const w = Number(comp.wearPorUnidad||1); const u = totalComp*(w>0?w:1); if(u>0) wearList.push({ productoId: cpid, unidades: u, origenProductoId: pid, origenProductoDesc: pdata.descripcion||null });
      } else {
        insumoDec[cpid] = (insumoDec[cpid]||0) + totalComp;
      }
    }
    await window.db.runTransaction(async tx=>{
      for(const cpid of Object.keys(insumoDec)){
        const dec = Number(insumoDec[cpid]||0); if(!(dec>0)) continue;
        const ref = col(collectionsMap.productos).doc(cpid);
        tx.update(ref, { existencias: firebase.firestore.FieldValue.increment(-dec) });
      }
    });
    // Post: incrementar desgaste de consumibles
    for(const w of wearList){
      try{ await window.firebaseApi.incrementarDesgasteConsumible({ productoId: w.productoId, unidades: w.unidades, origenProductoId: w.origenProductoId, origenProductoDesc: w.origenProductoDesc, origenVentaFolio: null }); } catch(_e){}
    }
    return true;
  }
  ,
  /** Marca llegada o escaneo con campos auxiliares */
  async markVentaArribo(ventaId, type){
    const ventaRef = col('ventas').doc(ventaId);
    const data = type==='LLEGADA'? { llegadaAt: firebase.firestore.FieldValue.serverTimestamp() } : { escaneadoAt: firebase.firestore.FieldValue.serverTimestamp() };
    await ventaRef.set(data, { merge:true });
  }
  ,
  /** Obtiene historial de producción de la venta (array de {de,a,fecha,ts,userId}) */
  async getVentaProduccionHist(ventaId){
    if(!ventaId) throw new Error('ventaId requerido');
    const colRef = col('ventas').doc(ventaId).collection('produccion_hist').orderBy('ts','desc').limit(50);
    const snap = await colRef.get();
    return snap.docs.map(d=> ({ id:d.id, ...d.data() }));
  }
};

// --- Categoría de producción dinámica ---
// Deriva una categoría para la venta a partir de sus items (por ahora: primer item con campo categoriaProducto o tipo)
window.assignVentaProductionCategory = async function assignVentaProductionCategory(ventaId){
  try {
    const ventaRef = col('ventas').doc(ventaId);
    const snap = await ventaRef.get();
    if(!snap.exists) return;
    const v = snap.data();
    if(v.categoriaProd) return; // ya asignada
    // Leer un item para inferir
    const itemsSnap = await ventaRef.collection('items').limit(5).get();
    let categoria = 'GENERAL';
    for(const d of itemsSnap.docs){
      const it = d.data();
      if(it.categoria){ categoria = it.categoria; break; }
      if(it.tipo){ categoria = it.tipo; break; }
      // Buscar producto para más metadata
      if(it.productoId){
        const pSnap = await col(collectionsMap.productos).doc(it.productoId).get();
        if(pSnap.exists && pSnap.data().categoria){ categoria = pSnap.data().categoria; break; }
      }
    }
    await ventaRef.set({ categoriaProd: categoria }, { merge:true });
  } catch(e){ console.warn('assignVentaProductionCategory fallo', e); }
};

// Listener auxiliar opcional para asignar categoría recién creadas (puede llamarse desde UI tras crear venta)
window.ensureVentasCategorias = async function ensureVentasCategorias(){
  if(!Array.isArray(window.ventas)) return;
  const pending = window.ventas.filter(v=> !v.categoriaProd).slice(0,20);
  for(const v of pending){ await window.assignVentaProductionCategory(v.id); }
};

// --- API Cotizaciones ---
window.firebaseQuotesApi = {
  /** Crea cotización con folio secuencial usando counters/cotizaciones.seq */
  async createCotizacion(data){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
    const refCounter = col('counters').doc('cotizaciones');
    const folio = await window.db.runTransaction(async(tx)=>{
      const snap = await tx.get(refCounter);
      let prev = 60;
      if(snap.exists){ const d=snap.data(); if(typeof d.seq==='number') prev = d.seq; }
      const next = prev + 1;
      tx.set(refCounter,{ seq: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },{ merge:true });
      return next;
    });
    const docRef = col(collectionsMap.cotizaciones).doc();
    // Intentar resolver clienteId (si viene nombre y no id)
    let clienteId = data.clienteId || null;
    let clienteNombre = data.cliente || data.clienteNombre || 'PUBLICO EN GENERAL';
    if(!clienteId && Array.isArray(window.clientes)){
      const match = window.clientes.find(c=> (c.nombre||'').toLowerCase() === clienteNombre.toLowerCase());
      if(match) clienteId = match.id;
    }
    const payload = {
      folio,
      cliente: clienteNombre,
      clienteNombre,
      clienteId: clienteId || null,
      fecha: data.fecha || new Date().toISOString().slice(0,10),
      descripcion: data.descripcion||'',
      importe: +((data.importe)||0),
      descuento: +((data.descuento)||0),
      iva: +((data.iva)||0),
      otros: +((data.otros)||0),
      total: +((data.total)||0),
      usuario: data.usuario || 'Administrador',
      estado: 'pendiente',
      lineas: Array.isArray(data.lineas)? JSON.parse(JSON.stringify(data.lineas)) : [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: uid
    };
    await docRef.set(payload);
    auditLog && auditLog('create','cotizacion', docRef.id, { folio, total: payload.total });
    return folio;
  },
  async updateCotizacion(docId, patch){
    if(!docId) throw new Error('docId requerido');
    const ref = col(collectionsMap.cotizaciones).doc(docId);
    const data = { ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    await ref.set(data, { merge:true });
    auditLog && auditLog('update','cotizacion', docId, Object.keys(patch));
  },
  async deleteCotizacion(docId){
    if(!docId) throw new Error('docId requerido');
  await col(collectionsMap.cotizaciones).doc(docId).set({ estado:'cancelada', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
  auditLog && auditLog('cancel','cotizacion', docId, { estado:'cancelada' });
  },
  /** Convierte una cotización en venta (solo si pendiente). Opcionalmente registra pagoInicial */
  async convertCotizacion(docId, { pagoInicial=0 }={}){
    if(!docId) throw new Error('docId requerido');
    const ref = col(collectionsMap.cotizaciones).doc(docId);
    const snap = await ref.get();
    if(!snap.exists) throw new Error('Cotización no existe');
    const cot = snap.data();
    if(cot.estado === 'convertida') return cot.ventaId; // idempotente
    // Mapear líneas a items venta
    const items = Array.isArray(cot.lineas)? cot.lineas.map(l=>({
      productoId: l.productoId || null,
      descripcion: l.desc || l.descripcion || l.producto || 'ITEM',
      cantidad: l.cant || l.cantidad || 1,
      precio: l.pu || l.precio || (l.total && l.cant ? (l.total / l.cant) : l.total) || 0,
      costoUnit: l.costoUnit || 0
    })) : [];
    if(!items.length){
      // Si no hay líneas, crear un item único con importe total
      items.push({ productoId:null, descripcion: cot.descripcion||('COT '+cot.folio), cantidad:1, precio: cot.total||cot.importe||0, costoUnit:0 });
    }
    let clienteId = cot.clienteId || null;
    let clienteNombre = cot.clienteNombre || cot.cliente || 'CLIENTE';
    if(!clienteId && Array.isArray(window.clientes)){
      const match = window.clientes.find(c=> (c.nombre||'').toLowerCase() === (clienteNombre||'').toLowerCase());
      if(match) clienteId = match.id;
    }
    if(!clienteId){
      // Buscar cliente 'PUBLICO EN GENERAL'
      const publico = Array.isArray(window.clientes)? window.clientes.find(c=> (c.nombre||'').toLowerCase()==='publico en general') : null;
      if(publico){ clienteId = publico.id; clienteNombre = publico.nombre; }
    }
    if(!clienteId){
      throw new Error('No se pudo resolver clienteId para la cotización');
    }
    // Crear venta
    let ventaId = null;
    try {
      const ventaRes = await window.firebaseSalesApi.createVenta({ clienteId: clienteId || 'PUBLICO_EN_GENERAL', clienteNombre, items, pagoInicial });
      if(typeof ventaRes === 'string'){
        ventaId = ventaRes;
      } else if(ventaRes && typeof ventaRes === 'object'){
        ventaId = ventaRes.id || ventaRes.ventaId || null;
      }
    } catch(err){
      console.error('Error creando venta desde cotizacion', err);
      throw err;
    }
    await ref.set({ estado:'convertida', ventaId, convertedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    auditLog && auditLog('convert','cotizacion', docId, { ventaId });
    return ventaId;
  }
};

// --- API Facturación ---
window.firebaseBillingApi = {
  /** Crear factura con folio secuencial (counters/facturas) */
  async createFactura(data){
    if(!window._firebaseReady) throw new Error('Firebase no listo');
    const uid = window.auth?.currentUser?.uid || null;
    const refCounter = col('counters').doc('facturas');
    const db = window.db;
    let folio;
    await db.runTransaction(async(tx)=>{
      const snap = await tx.get(refCounter);
      const prev = snap.exists && typeof snap.data().seq==='number' ? snap.data().seq : 0;
      const next = prev + 1;
      tx.set(refCounter,{ seq: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },{ merge:true });
      folio = next;
    });
    // Resolver clienteId
    let clienteId = data.clienteId || null;
    let clienteNombre = data.cliente || data.clienteNombre || 'PUBLICO EN GENERAL';
    if(!clienteId && Array.isArray(window.clientes)){
      const match = window.clientes.find(c=> (c.nombre||'').toLowerCase() === clienteNombre.toLowerCase());
      if(match) clienteId = match.id;
    }
    if(!clienteId) throw new Error('clienteId no resuelto');
    const lineas = Array.isArray(data.conceptos)? JSON.parse(JSON.stringify(data.conceptos)) : [];
    // Calcular totales mínimos (usa campo total si viene)
    let subtotal=0, descuentos=0, iva=0, retIva=0, retIsr=0, total=0;
    lineas.forEach(l=>{ subtotal += (l.cant*l.precio) - (l.descuentoMonto||0); descuentos += (l.descuentoMonto||0); iva += (l.iva||0); retIva += (l.retIva||0); retIsr += (l.retIsr||0); total += (l.total|| ((l.cant*l.precio)-(l.descuentoMonto||0)+(l.iva||0)-(l.retIva||0)-(l.retIsr||0))); });
    total = parseFloat(total.toFixed(2));
    const saldo = total; const abonado = 0;
    const ref = col(collectionsMap.facturas).doc();
    const payload = {
      folio,
      clienteId,
      cliente: clienteNombre,
      fecha: data.fecha || new Date().toISOString().slice(0,10),
      subtotal, descuentos, iva, retIva, retIsr, total,
      abonado, saldo,
      status: 'BORRADOR',
      conceptos: lineas,
      ventaId: data.ventaId || null,
      usuario: data.usuario || 'Administrador',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: uid
    };
    await ref.set(payload);
    auditLog && auditLog('create','factura', ref.id, { folio, total, clienteId });
    return ref.id;
  },
  async updateFactura(docId, patch){
    if(!docId) throw new Error('docId requerido');
    await col(collectionsMap.facturas).doc(docId).set({ ...patch, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    auditLog && auditLog('update','factura', docId, Object.keys(patch));
  },
  async emitirFactura(docId){
    const ref = col(collectionsMap.facturas).doc(docId);
    await ref.set({ status:'EMITIDA', emitidaAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    auditLog && auditLog('emitir','factura', docId, {});
  },
  async cancelarFactura(docId){
    const ref = col(collectionsMap.facturas).doc(docId);
    await ref.set({ status:'CANCELADA', canceladaAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    auditLog && auditLog('cancel','factura', docId, {});
  },
  async abonarFactura(docId, monto){
    if(monto<=0) throw new Error('Monto inválido');
    const uid = window.auth?.currentUser?.uid || null;
    const ref = col(collectionsMap.facturas).doc(docId);
    await window.db.runTransaction(async(tx)=>{
      const snap = await tx.get(ref);
      if(!snap.exists) throw new Error('Factura no existe');
      const d = snap.data();
      if(d.status!=='EMITIDA') throw new Error('Solo facturas EMITIDA se pueden abonar');
      const saldo = d.saldo||0; if(saldo<=0) throw new Error('Saldo en cero');
      const apply = Math.min(saldo, monto);
      const nuevoAbonado = (d.abonado||0)+apply;
      const nuevoSaldo = parseFloat((d.total - nuevoAbonado).toFixed(2));
      tx.update(ref, { abonado: nuevoAbonado, saldo: nuevoSaldo });
      const abonosRef = ref.collection('abonos').doc();
      tx.set(abonosRef, { monto: apply, fecha: new Date().toISOString().slice(0,10), ts: firebase.firestore.FieldValue.serverTimestamp(), userId: uid });
      // Movimiento caja
      const cajaRef = col(collectionsMap.caja).doc();
      const usuarioName = (window.auth?.currentUser?.displayName || window.auth?.currentUser?.email || null);
      let id8 = null; try { id8 = await window.firebaseApi.getNextCajaId8Tx(tx); } catch(_e){}
      const cajaSucursal = (typeof d?.sucursal === 'string' && d.sucursal.trim()) ? d.sucursal.trim() : undefined;
      tx.set(cajaRef, deepClean({ 
        id8: id8 || null,
        fecha: new Date().toISOString().slice(0,10), 
        tipo:'FACTURA_ABONO', 
        monto: apply, 
        facturaId: ref.id, 
        facturaFolio: d.folio || undefined,
        descripcion: d.folio ? `Abono Factura ${d.folio}` : 'Abono a Factura',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), 
        userId: uid,
        usuario: usuarioName || undefined,
        sucursal: cajaSucursal
      }));
    });
    auditLog && auditLog('abono','factura', docId, { monto });
  }
};

// --- API Sucursales ---
window.firebaseBranchesApi = {
  async createSucursal(data){
  const payload = { ...data };
  if(!payload.codigo){ try { payload.codigo = await window.firebaseApi.generateUniqueSucursalCodigo(); } catch(_e){ payload.codigo = String(Math.floor(Math.random()*1e8)).padStart(8,'0'); } }
  const ref = await col(collectionsMap.sucursales).add({ ...payload, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    auditLog && auditLog('create','sucursal', ref.id, {}); return ref.id;
  },
  async updateSucursal(id, data){ await col(collectionsMap.sucursales).doc(id).set({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('update','sucursal', id, {}); },
  async deleteSucursal(id){ await col(collectionsMap.sucursales).doc(id).set({ estatus:'Inactiva', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); auditLog && auditLog('disable','sucursal', id, { estatus:'Inactiva' }); }
};

// --- Paginación básica (ventas / cotizaciones) ---
window.firebasePagination = (function(){
  let ventasCursor=null; let ventasLoaded=0; const ventasPageSize=200;
  let cotCursor=null; let cotLoaded=0; const cotPageSize=200;
  async function loadMoreVentas(){
    if(!window.db) throw new Error('DB no lista');
    let q = col('ventas').orderBy('fecha','desc').limit(ventasPageSize);
    if(ventasCursor) q = q.startAfter(ventasCursor);
    const snap = await q.get();
    if(!window.ventas) window.ventas=[];
    snap.forEach(doc=>{ if(!window.ventas.find(v=> v.id===doc.id)) window.ventas.push({ id:doc.id, _id:doc.id, ...doc.data() }); });
    ventasLoaded += snap.size; ventasCursor = snap.docs[snap.docs.length-1]||ventasCursor;
    if(typeof window.renderVentasCostos==='function') try { window.renderVentasCostos(); } catch(_e){}
    return { added: snap.size, total: window.ventas.length };
  }
  async function loadMoreCotizaciones(){
    const cRef = col(collectionsMap.cotizaciones);
    if(!cRef) throw new Error('Colección cotizaciones no lista');
    let q = cRef.orderBy('folio','desc').limit(cotPageSize);
    if(cotCursor) q = q.startAfter(cotCursor);
    const snap = await q.get();
    if(!window.cotizaciones) window.cotizaciones=[];
    snap.forEach(doc=>{ const d=doc.data(); if(!window.cotizaciones.find(c=> (c._docId||c.id)===doc.id)) window.cotizaciones.push({ id:d.folio, folio:d.folio, _docId:doc.id, ...d }); });
    cotLoaded += snap.size; cotCursor = snap.docs[snap.docs.length-1]||cotCursor;
    if(typeof window.renderCotizacionesTabla==='function') try { window.renderCotizacionesTabla(); } catch(_e){}
    return { added: snap.size, total: window.cotizaciones.length };
  }
  return { loadMoreVentas, loadMoreCotizaciones };
})();

// --- Utilidad para limpiar caché Firestore (IndexedDB) ---
window.clearFirestoreCache = async function(){
  const dbNames = await indexedDB.databases();
  const targets = dbNames.map(d=> d.name).filter(n=> n && n.includes('firestore')); // heurística
  for(const name of targets){
    try { await new Promise((res,rej)=>{ const req = indexedDB.deleteDatabase(name); req.onsuccess=()=>res(); req.onerror=()=>rej(req.error); req.onblocked=()=>res(); }); console.log('[Cache] Borrada DB', name); } catch(e){ console.warn('No se pudo borrar', name, e); }
  }
  alert('Caché Firestore eliminada. Recargando página...');
  setTimeout(()=> location.reload(), 600);
};

// --- Auditoría básica ---
function audit(action, entity, entityId, data){
  try {
    if(!window._firebaseReady) return;
    const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid)||null;
    const doc = {
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      action, entity, entityId: entityId||null,
      userId: uid,
      data: data ? JSON.parse(JSON.stringify(data)) : null,
      ua: navigator.userAgent || ''
    };
    col('logs').add(doc).catch(()=>{});
  } catch(e){ /* silent */ }
}
window.auditLog = audit;

// Helper de depuración: probar creación manual desde consola
window.testAddProducto = async function(){
  try {
    const id = await window.firebaseApi.addProducto({ descripcion:'TEST-'+Date.now(), precio:10, costo:5, existencias:1, inventario:'SI' });
    console.log('[testAddProducto] creado', id);
  } catch(e){ console.error('[testAddProducto] fallo', e); }
};

// --- Helpers para integrar con código existente ---
// Sobrescribimos persistState para que no dependa de localStorage (podrías mantenerlo si quieres cache local)
window.persistState = function(){ /* ahora se escribe por documento en tiempo real; no-op */ };

// Si el script principal intenta loadPersisted, podemos dejarlo como no-op (los listeners llenan el estado).
window.loadPersisted = function(){};

// Llamar automáticamente cuando DOM listo si los SDK ya se cargaron.
if(document.readyState === 'complete' || document.readyState === 'interactive'){
  setTimeout(()=> window.initFirebaseApp && window.initFirebaseApp(), 0);
} else {
  document.addEventListener('DOMContentLoaded', ()=> window.initFirebaseApp && window.initFirebaseApp());
}

console.log('[Firebase] Módulo firebase.js cargado');

// Fallback de arranque: mostrar el login por defecto para evitar pantalla en blanco
// Se ocultará automáticamente cuando Auth notifique un usuario activo.
(function ensureLoginVisibleOnBoot(){
  try {
    function showLogin(){
      const el = document.getElementById('loginContainer');
      if(el) el.classList.remove('hidden');
    }
    if(document.readyState === 'complete' || document.readyState === 'interactive') showLogin();
    else document.addEventListener('DOMContentLoaded', showLogin);
  } catch(_e){}
})();

function inferAdminFromDetail(detail){
  const matchToken = (val)=>{
    if(!val) return false;
    try{
      const token = String(val).toLowerCase();
      return token.includes('admin') || token.includes('super') || token.includes('gerente');
    }catch(_e){ return false; }
  };
  if(!detail) return false;
  if(typeof detail === 'string') return matchToken(detail);
  if(detail instanceof Set){
    for(const item of detail){ if(matchToken(item)) return true; }
    return false;
  }
  if(Array.isArray(detail)) return detail.some(matchToken);
  if(typeof detail === 'object'){
    if(detail.isAdmin === true) return true;
    if(matchToken(detail.role)) return true;
    if(matchToken(detail.perfil)) return true;
    if(Array.isArray(detail.roles) && detail.roles.some(matchToken)) return true;
    if(Array.isArray(detail.permisos) && detail.permisos.some(matchToken)) return true;
    if(detail.roles instanceof Set){ for(const item of detail.roles){ if(matchToken(item)) return true; } }
    if(detail.permisos instanceof Set){ for(const item of detail.permisos){ if(matchToken(item)) return true; } }
    const tags = detail.tags;
    if(tags instanceof Set){ for(const item of tags){ if(matchToken(item)) return true; } }
    else if(Array.isArray(tags) && tags.some(matchToken)) return true;
    if(detail.user && detail.user !== detail && inferAdminFromDetail(detail.user)) return true;
  }
  return false;
}

function updateLogoutButtonVisibility(detail){
  const btn = document.getElementById('logoutBtn');
  if(!btn) return;
  const user = window.auth?.currentUser || null;
  let show = false;
  if(user){
    if(inferAdminFromDetail(detail)) show = true;
    if(!show && typeof window.currentUserAccess !== 'undefined' && window.currentUserAccess){
      if(window.currentUserAccess.isAdmin === true || inferAdminFromDetail(window.currentUserAccess)) show = true;
    }
    if(!show){
      const role = window.currentUserRole || '';
      if(inferAdminFromDetail(role)) show = true;
    }
  }
  const busy = btn.dataset.busy === '1';
  btn.classList.toggle('hidden', !show);
  btn.setAttribute('aria-hidden', show ? 'false' : 'true');
  btn.tabIndex = show ? 0 : -1;
  const disabled = (!show) || busy;
  btn.disabled = disabled;
  btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

async function handleManualLogoutClick(ev){
  try{ ev.preventDefault(); }catch(_e){}
  const btn = ev.currentTarget;
  if(btn.dataset.busy === '1') return;
  if(!(window.auth && window.auth.currentUser)){
    updateLogoutButtonVisibility(null);
    return;
  }
  try{ btn.blur(); }catch(_e){}
  btn.dataset.busy = '1';
  updateLogoutButtonVisibility();
  try{
    await window.auth.signOut();
    try{ notify && notify('Sesión cerrada','info'); }catch(_e){}
  }catch(err){
    console.warn('[Auth] Sign-out manual falló', err);
    try{ notify && notify('No se pudo cerrar la sesión','err'); }catch(_e){}
  } finally {
    delete btn.dataset.busy;
    updateLogoutButtonVisibility();
  }
}

document.addEventListener('authRoleReady', ev=>{
  try{ updateLogoutButtonVisibility(ev && ev.detail ? ev.detail : null); }catch(_e){}
});
document.addEventListener('authResolved', ()=>{
  try{ updateLogoutButtonVisibility(window.currentUserAccess || null); }catch(_e){}
});

// --- Autenticación ---
function attachAuthListener(){
  if(!window.auth) return;
  window.auth.onAuthStateChanged(user=>{
  const loginContainer = document.getElementById('loginContainer');
  const loginSection = document.getElementById('login-section');
    const sidebar = document.getElementById('appNav'); // actualizar al nuevo menú lateral
    const mainContent = document.querySelector('.main-content');
  const logoutBtn = document.getElementById('logoutBtn');
  const appHeader = document.getElementById('appHeader');
  const brandHeader = document.getElementById('brandHeader');
  const userChip = document.getElementById('currentUserName');
  // Update CSS var for app-header offset under brand-header
  try {
    const updateBrandH = ()=>{
      const h = brandHeader && !brandHeader.classList.contains('hidden') ? brandHeader.offsetHeight : 0;
      document.documentElement.style.setProperty('--brandHeaderH', h + 'px');
    };
    updateBrandH();
    window.addEventListener('resize', updateBrandH, { passive: true });
  } catch(_e){}
    const roleEl = document.querySelector('.user-role');
    if(user){
      updateLogoutButtonVisibility(null);
      // Limpia inmediatamente el estado sensible para evitar ver datos de otro usuario
      try {
        window._ventasAll = [];
        window.ventas = [];
        if(window.AppState) window.AppState.ventas = [];
        try { document.dispatchEvent(new CustomEvent('ventasUpdated', { detail: { total: 0, fecha: null, soloHoy: true } })); } catch(_e){}
        try { if(typeof window.rebuildCxcFromVentas === 'function') window.rebuildCxcFromVentas(); } catch(_e){}
      } catch(_e){}
      // Mostrar app
  if(loginContainer) loginContainer.classList.add('hidden');
  if(loginSection) loginSection.classList.add('hidden');
  if(sidebar) sidebar.classList.remove('hidden');
      if(mainContent) mainContent.classList.remove('hidden');
  if(appHeader) appHeader.classList.remove('hidden');
  try {
    // Calcular altura del app header tras hacerlo visible
    requestAnimationFrame(()=>{
      const h2 = appHeader ? appHeader.offsetHeight : 0;
      document.documentElement.style.setProperty('--appHeaderH', h2 + 'px');
    });
  } catch(_e){}
      if(brandHeader) brandHeader.classList.remove('hidden');
      try {
        // Calcular altura del brand header tras hacerlo visible
        requestAnimationFrame(()=>{
          const h = brandHeader ? brandHeader.offsetHeight : 0;
          document.documentElement.style.setProperty('--brandHeaderH', h + 'px');
        });
      } catch(_e){}
      if(userChip){
        try { userChip.textContent = (user && (user.displayName || user.email || '')); } catch(_e){}
      }
  // No brandUserEmail/Name anymore; show email in user chip
  try { if(userChip && user && user.email) userChip.textContent = user.email; } catch(_e){}
      updateLogoutButtonVisibility(window.currentUserAccess || null);
      const userNameEl = document.querySelector('.user-name');
      if(userNameEl){ userNameEl.textContent = user.email || 'Usuario'; }
      loadUserProfile(user.uid, roleEl);

      // Al iniciar sesión, regresar al último módulo visitado (fallback a Venta)
      try {
        const goInitialModule = ()=>{
          let storedNav = '';
          try{ storedNav = localStorage.getItem('maq:lastNavId') || ''; }catch(_e){}
          let urlNav = '';
          try{
            const path = (location.pathname||'').replace(/^\/+/, '');
            if(path){
              const clean = decodeURIComponent(path);
              if(clean.startsWith('nav-')) urlNav = clean;
            }
          }catch(_e){}
          const candidateNav = storedNav || urlNav;
          const isValid = candidateNav && navSectionMap && navSectionMap[candidateNav];
          const targetNav = isValid ? candidateNav : 'nav-venta';
          if(typeof window.__handleNavigation === 'function'){
            window.__handleNavigation(targetNav);
            return true;
          }
          return false;
        };
        if(!goInitialModule()){
          let tries = 0;
          const t = setInterval(()=>{
            if(goInitialModule() || ++tries>=20){
              clearInterval(t);
              if(tries>=20){
                try{
                  const venta = document.getElementById('venta-section');
                  if(venta){
                    document.querySelectorAll('section').forEach(sec=>{
                      if(!window.auth?.currentUser && sec.id === 'login-section') return;
                      sec.classList.add('hidden');
                    });
                    venta.classList.remove('hidden');
                  }
                }catch(_e){}
              }
            }
          }, 150);
        }
      } catch(_e){}
  try{ document.dispatchEvent(new Event('authResolved')); }catch(_e){}
  // Forzar un ciclo de layout para que se actualicen las alturas dependientes (equivalente al resize al cerrar DevTools)
      try { window.dispatchEvent(new Event('resize')); } catch(_e){}
      // Invariante: usuario logeado => turno ABIERTO. Si no hay, abrirlo automáticamente.
      try{
        (async ()=>{
          try{
            let abierto = await (window.firebaseApi && window.firebaseApi.getTurnoAbierto ? window.firebaseApi.getTurnoAbierto() : null);
            if(!abierto){
              try{
                const id = await (window.firebaseApi && window.firebaseApi.openTurno ? window.firebaseApi.openTurno() : Promise.reject(new Error('API de turnos no disponible')));
                abierto = { id };
              }catch(_e){}
            }
            if(abierto && abierto.id){ window.currentTurnoId = abierto.id; }
          }catch(_e){}
          try { document.dispatchEvent(new Event('turno:changed')); } catch(_e){}
          try { document.dispatchEvent(new Event('auth:ready')); } catch(_e){}
          // Nota: no iniciamos startTurnoBoundaryWatcher() para respetar que el cierre sólo sucede con Corte.
        })();
      }catch(_e){}
    } else {
      // Ocultar app y mostrar login
  if(loginContainer) loginContainer.classList.remove('hidden');
  if(loginSection) loginSection.classList.remove('hidden');
  if(sidebar) sidebar.classList.add('hidden');
  if(mainContent) mainContent.classList.add('hidden');
  if(appHeader) appHeader.classList.add('hidden');
  try { document.documentElement.style.setProperty('--appHeaderH', '0px'); } catch(_e){}
  if(brandHeader) brandHeader.classList.add('hidden');
  try {
    document.documentElement.style.setProperty('--brandHeaderH', '0px');
  } catch(_e){}
  updateLogoutButtonVisibility(null);
      if(roleEl) roleEl.textContent = '';
  try { stopTurnoBoundaryWatcher(); } catch(_e){}
      // Limpiar ventas en memoria al cerrar sesión para no ver datos residuales
      try {
        window._ventasAll = [];
        window.ventas = [];
        if(window.AppState) window.AppState.ventas = [];
        try { document.dispatchEvent(new CustomEvent('ventasUpdated', { detail: { total: 0, fecha: null, soloHoy: true } })); } catch(_e){}
        try { if(typeof window.rebuildCxcFromVentas === 'function') window.rebuildCxcFromVentas(); } catch(_e){}
      } catch(_e){}
    }
  });
  // Wire login form
  const form = document.getElementById('loginForm');
  if(form){
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const pass = document.getElementById('loginPassword').value.trim();
      const errBox = document.getElementById('loginError');
      if(errBox) { errBox.classList.add('hidden'); errBox.textContent=''; }
      try {
        await window.auth.signInWithEmailAndPassword(email, pass);
      } catch(err){
        try{ console.warn('[Auth] signIn failed', err); }catch(_log){}
        if(errBox){ errBox.textContent = mapAuthError(err); errBox.classList.remove('hidden'); }
      }
    });
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if(logoutBtn && !logoutBtn._bound){
    logoutBtn.addEventListener('click', handleManualLogoutClick);
    logoutBtn._bound = true;
  }
  updateLogoutButtonVisibility(window.currentUserAccess || null);
}

// =====================
// Turno boundary watcher (auto-split AM->PM)
// =====================
function stopTurnoBoundaryWatcher(){
  try { if(window.__turnoBoundaryTimer){ clearInterval(window.__turnoBoundaryTimer); window.__turnoBoundaryTimer = null; } } catch(_e){}
}
function startTurnoBoundaryWatcher(){
  stopTurnoBoundaryWatcher();
  const tz = __TURNOS_CFG__.tz || 'America/Mexico_City';
  const pmStartMin = parseHhmmToMinutes(__TURNOS_CFG__.pmStart)||900;
  async function tick(){
    try{
      if(!window.auth?.currentUser) return;
      if(!window.currentTurnoId){
        // Ensure there's an open turno
        try { await window.firebaseApi.openTurno(); } catch(_e){}
        return;
      }
      // Fetch current turno to check planned segment and status
      let turnoDoc = null;
      try{
        const snap = await col(collectionsMap.cajaTurnos).doc(String(window.currentTurnoId)).get();
        if(snap.exists) turnoDoc = { id: snap.id, ...snap.data() };
      }catch(_e){}
      if(!turnoDoc || String(turnoDoc.estatus||'abierto').toLowerCase()!=='abierto') return;
      const now = new Date();
      const nowMin = minutesSinceMidnight(now, tz);
      // If it's PM window and current turno was planned AM, roll to a new PM turno
      const planned = String(turnoDoc.turnoPlanificado||'AM').toUpperCase();
  if(__TURNOS_CFG__.autoSplit!==false && nowMin >= pmStartMin && planned==='AM'){
        try {
          await window.firebaseApi.closeTurno({});
        } catch(_e){}
        try {
          await window.firebaseApi.openTurno();
          try { document.dispatchEvent(new Event('turno:changed')); } catch(_e){}
        } catch(_e){}
      }
    }catch(_e){}
  }
  // Run at start and every 60s
  tick();
  window.__turnoBoundaryTimer = setInterval(tick, 60*1000);
}

function mapAuthError(err){
  if(!err || !err.code) return 'Error desconocido';
  const map = {
    'auth/invalid-email':'Correo inválido',
    'auth/user-disabled':'Usuario deshabilitado',
    'auth/user-not-found':'Usuario no encontrado',
    'auth/wrong-password':'Contraseña incorrecta',
    'auth/too-many-requests':'Demasiados intentos, espera un momento'
  };
  return map[err.code]||('Error: '+err.code);
}

// Helpers públicos para crear usuario admin inicial (usar solo temporal y luego eliminar)
window.firebaseAuthHelpers = {
  async createUser(email, password){ return window.auth.createUserWithEmailAndPassword(email,password); },
  async login(email,password){ return window.auth.signInWithEmailAndPassword(email,password); },
  async logout(){
  // Modo manual: no cerrar turno automáticamente al cerrar sesión
  return window.auth.signOut();
  },
  async setUserRole(uid, role){ return col(collectionsMap.usuarios).doc(uid).set({ role, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true }); }
};

async function loadUserProfile(uid, roleEl){
  try {
    const doc = await col(collectionsMap.usuarios).doc(uid).get();
    let role = 'sin-rol';
    if(doc.exists){ role = doc.data().role || role; }
    else {
      // Si el usuario autenticado no existe en el catálogo de usuarios, darlo de alta con rol Administrador
      try {
        const curr = window.auth?.currentUser || null;
        const isAnon = !!(curr && (curr.isAnonymous === true || !curr.email));
        // Para sesiones anónimas o sin correo, no elevar privilegios: crear perfil mínimo 'viewer'.
        if(isAnon){
          const payload = {
            perfil: 'Invitado',
            role: 'viewer',
            estatus: 'Activo',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: uid
          };
          await col(collectionsMap.usuarios).doc(uid).set(payload, { merge:true });
          role = 'viewer';
        } else {
          // Usuario real (con email): crear como admin inicial si no existe.
          let codigo = null;
          try { codigo = await window.firebaseApi?.generateUniqueUsuarioCodigo?.(); } catch(_e){}
          if(!codigo){ try { codigo = String(Math.floor(Math.random()*1e8)).padStart(8,'0'); } catch(_e){ codigo = null; } }
          const nombre = (curr?.displayName || (curr?.email ? String(curr.email).split('@')[0] : 'Administrador'));
          const correo = curr?.email || '';
          const payload = {
            nombre,
            nombreLower: String(nombre||'').trim().toLowerCase(),
            correo,
            perfil: 'Administrador',
            role: 'admin',
            sucursal: '',
            estatus: 'Activo',
            codigo: codigo || random8Digits(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: uid
          };
          await col(collectionsMap.usuarios).doc(uid).set(payload, { merge:true });
          role = payload.role;
        }
      } catch(_e){ /* silent */ }
    }
    if(roleEl) roleEl.textContent = '('+role+')';
    window.currentUserRole = role;
    applyRoleGuards(role);
  try { document.dispatchEvent(new CustomEvent('authRoleReady', { detail:{ role } })); } catch(_e){}
  } catch(e){ console.warn('No se pudo cargar perfil usuario', e); if(roleEl) roleEl.textContent='(rol ?)'; }
}

function applyRoleGuards(role){
  // Ejemplo simple: si role es 'viewer' ocultar botones de escritura
  // Nota: CSS no soporta selector de atributo "!=", se reemplaza por :not()
  const writeButtons = document.querySelectorAll('[data-requires="write"]:not([data-requires="none"])');
  writeButtons.forEach(btn=>{
    if(role === 'viewer'){
      btn.setAttribute('disabled','disabled');
      btn.classList.add('btn-disabled');
      if(!btn.getAttribute('title')) btn.setAttribute('title','Sin permiso para escribir (rol viewer)');
    }
    else {
      btn.removeAttribute('disabled');
      btn.classList.remove('btn-disabled');
      if(btn.getAttribute('title')==='Sin permiso para escribir (rol viewer)') btn.removeAttribute('title');
    }
  });
}

// --- Reconstrucción dinámica de CxC desde ventas (ventas recientes en memoria) ---
window.rebuildCxcFromVentas = function rebuildCxcFromVentas(){
  // Construir CxC por cliente con política de COSTO ÚNICAMENTE:
  // Para cada venta activa: costoPend = max(0, costoTotal - abonosPersonalesAcumulado)
  // y saldoCliente = max(0, total - pagado). Lo mostrado en CxC es min(saldoCliente, costoPend).
  function build(list){
    const cxcMap = {}; // clienteId->{clienteNombre, saldo, ultimoPago}
    list.forEach(v=>{
      if(v.status === 'CANCELADA') return;
      const total = Number(v.total||0);
      const pagado = Number(v.pagado||0);
      let saldoCliente = (typeof v.saldo === 'number') ? Number(v.saldo) : (total - pagado);
      if(!Number.isFinite(saldoCliente)) saldoCliente = 0;
      const costoTot = Number(v.costoTotal||0);
      const abonPers = Number(v.abonosPersonalesAcumulado||0);
      const costoPend = Math.max(0, costoTot - abonPers);
      // Monto relevante de CxC bajo política de costo-only
      const costoPorCobrar = Math.min(Math.max(0, saldoCliente), costoPend);
      if(costoPorCobrar <= 0) return; // solo adeudos de costo
      const cid = v.clienteId || 'SIN';
      if(!cxcMap[cid]) cxcMap[cid] = { clienteId: cid, cliente: v.clienteNombre||'SIN NOMBRE', saldo:0, ultimoPago:null };
      cxcMap[cid].saldo += costoPorCobrar;
      const abonoDate = v.lastAbonoDate || ((Number(v.pagoInicial||0)>0)? v.fecha: null);
      if(abonoDate){
        if(!cxcMap[cid].ultimoPago || abonoDate > cxcMap[cid].ultimoPago) cxcMap[cid].ultimoPago = abonoDate;
      }
    });
    return Object.values(cxcMap).sort((a,b)=> (b.saldo||0)-(a.saldo||0));
  }
  const ventas = Array.isArray(window.ventas)? window.ventas: [];
  let cxcArr = build(ventas);
  // Fallback: si quedó vacío (por filtro de fecha) y tenemos histórico reciente, usarlo
  if(!cxcArr.length && Array.isArray(window._ventasAll) && window._ventasAll.length){
    try { cxcArr = build(window._ventasAll); } catch(_e){}
  }
  window.cxcData = cxcArr; // utilizado por script.js renderCxc
  if(typeof window.renderCxc === 'function'){
    try { window.renderCxc(); } catch(e){ /* silent */ }
  }
  // Aging buckets (0-15,16-30,31-60,61-90, >90) usando el mismo monto de costoPorCobrar
  const hoy = new Date();
  function dias(f){ if(!f) return 0; const d=new Date(f+'T00:00:00'); return Math.floor((hoy - d)/(1000*60*60*24)); }
  let b0_15=0,b16_30=0,b31_60=0,b61_90=0,b90p=0,total=0;
  ventas.forEach(v=>{
    if(v.status==='CANCELADA') return;
    const totalV = Number(v.total||0);
    const pagadoV = Number(v.pagado||0);
    const saldoCli = Math.max(0, (typeof v.saldo==='number'? Number(v.saldo) : (totalV - pagadoV)));
    const costoPendV = Math.max(0, Number(v.costoTotal||0) - Number(v.abonosPersonalesAcumulado||0));
    const monto = Math.min(saldoCli, costoPendV);
    if(!(monto>0)) return;
    total += monto;
    const dd = dias(v.fecha);
    if(dd<=15) b0_15 += monto; else if(dd<=30) b16_30 += monto; else if(dd<=60) b31_60 += monto; else if(dd<=90) b61_90 += monto; else b90p += monto;
  });
  window.cxcAging = { b0_15,b16_30,b31_60,b61_90,b90p,total };
  const agingEl = document.getElementById('kpiCxcAging');
  if(agingEl){ agingEl.textContent = `0-15:$${b0_15.toFixed(0)} 16-30:$${b16_30.toFixed(0)} 31-60:$${b31_60.toFixed(0)} 61-90:$${b61_90.toFixed(0)} 90+:$${b90p.toFixed(0)}`; agingEl.classList.remove('ok','warn','risk'); const atraso = b31_60 + b61_90 + b90p; if(atraso===0) agingEl.classList.add('ok'); else if(b90p===0) agingEl.classList.add('warn'); else agingEl.classList.add('risk'); }
};

// --- Verificador de integridad (ventas / facturas / counters) ---
window.runIntegrityCheck = async function runIntegrityCheck(){
  const issues = [];
  try {
    // Ventas en memoria (listener). Para chequeos más estrictos se podría paginar.
    const ventas = Array.isArray(window.ventas)? window.ventas: [];
    ventas.forEach(v=>{
      if(typeof v.total === 'number' && typeof v.pagado === 'number'){
        if(parseFloat((v.pagado + v.saldo).toFixed(2)) !== parseFloat((v.total).toFixed(2))){
          issues.push({ tipo:'VENTA_INCONSISTENTE_TOTAL', id:v.id, detalle:`total=${v.total} pagado=${v.pagado} saldo=${v.saldo}` });
        }
        if(v.pagado < 0) issues.push({ tipo:'VENTA_PAGADO_NEG', id:v.id });
        if(v.saldo < 0) issues.push({ tipo:'VENTA_SALDO_NEG', id:v.id });
      }
      if(v.status==='CANCELADA' && v.saldo!==0) issues.push({ tipo:'VENTA_CANCELADA_SALDO', id:v.id, saldo:v.saldo });
    });
    // Facturas
    const facturas = Array.isArray(window.facturas)? window.facturas: [];
    facturas.forEach(f=>{
      if(typeof f.total==='number' && typeof f.abonado==='number' && typeof f.saldo==='number'){
        if(parseFloat(((f.abonado + f.saldo)).toFixed(2)) !== parseFloat((f.total).toFixed(2))){
          issues.push({ tipo:'FACTURA_INCONSISTENTE_TOTAL', id:f.id, detalle:`total=${f.total} abonado=${f.abonado} saldo=${f.saldo}` });
        }
        if(f.abonado < 0) issues.push({ tipo:'FACTURA_ABONADO_NEG', id:f.id });
        if(f.saldo < 0) issues.push({ tipo:'FACTURA_SALDO_NEG', id:f.id });
      }
    });
    // Duplicados folios: cotizaciones / facturas (en memoria)
    function detectDup(arr, field, label){
      const map = {}; arr.forEach(a=>{ const k=a[field]; if(k==null) return; map[k]=(map[k]||0)+1; });
      Object.entries(map).forEach(([folio,count])=>{ if(count>1) issues.push({ tipo:`${label}_FOLIO_DUP`, folio, count }); });
    }
    detectDup(Array.isArray(window.cotizaciones)? window.cotizaciones: [], 'folio', 'COTIZACION');
    detectDup(facturas, 'folio', 'FACTURA');
    // Counters gap simple (lee counters docs en vivo)
    try {
      const cSnap = await col('counters').get();
      cSnap.forEach(d=>{ const data=d.data(); if(typeof data.seq!=='number') issues.push({ tipo:'COUNTER_SIN_SEQ', id:d.id }); });
    } catch(e){ issues.push({ tipo:'COUNTERS_READ_ERROR', detalle:e.message }); }
  } catch(e){ issues.push({ tipo:'CHECK_EXCEPTION', detalle:e.message }); }
  // Reporte
  if(!issues.length){ console.info('[Integrity] OK sin problemas'); alert('Integridad: sin problemas detectados'); return []; }
  console.warn('[Integrity] Problemas detectados', issues);
  // Construir modal simple si existe contenedor
  try {
    let modal = document.getElementById('integrityModal');
    if(!modal){
      modal = document.createElement('div');
      modal.id='integrityModal';
      modal.style = 'position:fixed;top:10%;left:50%;transform:translateX(-50%);background:#fff;padding:16px;max-width:600px;max-height:60vh;overflow:auto;z-index:9999;border:2px solid #c00;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      const closeBtn = document.createElement('button'); closeBtn.textContent='Cerrar'; closeBtn.onclick=()=> modal.remove(); modal.appendChild(closeBtn);
      const h = document.createElement('h3'); h.textContent='Verificación de Integridad'; modal.appendChild(h);
      const list = document.createElement('ul'); list.id='integrityList'; modal.appendChild(list);
      document.body.appendChild(modal);
    }
    const list = modal.querySelector('#integrityList'); list.innerHTML='';
    issues.forEach(i=>{ const li=document.createElement('li'); li.textContent = `${i.tipo}: ${i.id||i.folio||''} ${i.detalle||''}`; li.style.color='#c00'; list.appendChild(li); });
  } catch(e){ alert('Problemas: '+issues.map(i=>i.tipo).join(', ')); }
  return issues;
};

// Atajo para correr ambos (categorías faltantes + integridad)
window.runMaintenanceQuick = async function(){ await window.ensureVentasCategorias(); await window.runIntegrityCheck(); };

// End of firebase.js

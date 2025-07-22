<script>
    // Configuración Firebase
    const firebaseConfig = {
      apiKey: "AIzaSyAr8-ybVqcaeubCs-bApA_FAKnDgj9S7vM",
      authDomain: "maquilero-8344b.firebaseapp.com",
      projectId: "maquilero-8344b",
      storageBucket: "maquilero-8344b.firebasestorage.app",
      messagingSenderId: "323366654858",
      appId: "1:323366654858:web:5527744db419863da6ee73",
      measurementId: "G-H26F2MCQWD"
    };
    firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();

    // Datos en memoria
    let productos = [], clientes = [], pedidos = [], pendingListos = [];
    let mapClientes, mapRuta, markersClientes, routingControl;
    let mapClientesInit=false, mapRutaInit=false;
    let currentFilter='todos';

    // Helpers
    function debounce(fn, delay=300){
      let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a),delay); };
    }
    function resetForm(id){
      const f=document.getElementById(id);
      f.reset(); f.querySelector('input[type=hidden]').value='';
      ['#divPedidoBordados','#divPedidoDisenoIncluido','#divPedidoOpcionesDiseno']
        .forEach(s=>document.querySelector(s)?.classList.add('hidden'));
    }

    // Pestañas
    async function showTab(id){
      document.querySelectorAll('.tab-content').forEach(s=>s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelector(`.tab-btn[onclick="showTab('${id}')"]`).classList.add('active');
      if(id==='clientes') initMapClientes();
      if(id==='pedidos') calcularRuta();
      if(id==='reportes') actualizarReportes();
    }

    // Inicialización y escuchas en tiempo real
    window.addEventListener('load', ()=>{
      bindClientSearch(); bindProductSearch(); setupPedidoFilters();

      db.collection('productos').onSnapshot(snap=>{
        productos=snap.docs.map(d=>({id:d.id,...d.data()}));
        listarProductos(); renderPedidos();
      });
      db.collection('clientes').onSnapshot(snap=>{
        clientes=snap.docs.map(d=>({id:d.id,...d.data()}));
        listarClientes(); renderPedidos();
      });
      db.collection('pedidos').onSnapshot(snap=>{
        pedidos=snap.docs.map(d=>({id:d.id,...d.data()}));
        renderPedidos(); actualizarReportes();
      });
    });

    // Productos
    function listarProductos(){
      const tb=document.querySelector('#tablaProductos tbody'); tb.innerHTML='';
      productos.forEach(p=>{
        const ops=(p.opcionesDiseno||[]).map(o=>`${o.nombre}($${o.precio.toFixed(2)})`).join(', ');
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td>${p.descripcion}</td>
          <td>${p.esBordado||'No'}</td>
          <td>${p.incluyeDiseno||'No'}</td>
          <td>${ops}</td>
          <td>${p.diasHabiles}</td>
          <td>${p.rastreable}</td>
          <td>${p.stock}</td>
          <td>$${p.precio.toFixed(2)}</td>
          <td><button class="icon-btn" onclick="editarProducto('${p.id}')"><i class="ri-edit-line"></i></button></td>
          <td><button class="icon-btn" onclick="eliminarProducto('${p.id}')"><i class="ri-delete-bin-line"></i></button></td>`;
        tb.appendChild(tr);
      });
    }
    document.getElementById('formProducto').addEventListener('submit',async e=>{
      e.preventDefault();
      const id=document.getElementById('prodIdEditar').value;
      const desc=document.getElementById('prodDescripcion').value.trim();
      const esBor=document.getElementById('prodBordado').value;
      const incBor=document.getElementById('prodIncluyeBordadoExtra').value;
      const preBor=parseFloat(document.getElementById('prodPrecioBordado').value)||0;
      const incDes=document.getElementById('prodIncluyeDiseno').value;
      const dias=parseInt(document.getElementById('prodDiasHabiles').value)||1;
      const rast=document.getElementById('prodRastreable').value;
      const stk=rast==='Sí'?parseInt(document.getElementById('prodStock').value)||0:0;
      const pre=parseFloat(document.getElementById('prodPrecio').value);
      if(!desc||isNaN(pre)){ alert('Completa campos'); return; }
      let ops=[];
      if(incDes==='Sí'){
        ops=Array.from(document.querySelectorAll('#disenoOptionsContainer > div'))
          .map(r=>({ nombre:r.querySelector('.optName').value.trim(),
                     precio:parseFloat(r.querySelector('.optPrice').value)||0 }))
          .filter(o=>o.nombre);
      }
      const data={ descripcion:desc, esBordado:esBor,
                   incluyeBordadoExtra:incBor, precioBordadoExtra:preBor,
                   incluyeDiseno:incDes, opcionesDiseno:ops,
                   diasHabiles:dias, rastreable:rast,
                   stock:stk, precio:pre };
      if(id) await db.collection('productos').doc(id).update(data);
      else   await db.collection('productos').add(data);
      resetForm('formProducto'); document.getElementById('btnCancelarEdicionProducto').classList.add('hidden');
    });
    window.editarProducto=id=>{
      const p=productos.find(x=>x.id===id); if(!p)return;
      document.getElementById('prodIdEditar').value=id;
      document.getElementById('prodDescripcion').value=p.descripcion;
      document.getElementById('prodBordado').value=p.esBordado; toggleBordadoExtra();
      document.getElementById('prodIncluyeBordadoExtra').value=p.incluyeBordadoExtra;
      document.getElementById('prodPrecioBordado').value=p.precioBordadoExtra;
      document.getElementById('prodIncluyeDiseno').value=p.incluyeDiseno; toggleDisenoExtra();
      const c=document.getElementById('disenoOptionsContainer'); c.innerHTML='';
      (p.opcionesDiseno||[]).forEach(o=>{
        document.getElementById('btnAgregarOpcionDiseno').click();
        const last=c.lastElementChild;
        last.querySelector('.optName').value=o.nombre;
        last.querySelector('.optPrice').value=o.precio;
      });
      document.getElementById('prodDiasHabiles').value=p.diasHabiles;
      document.getElementById('prodRastreable').value=p.rastreable; toggleStockInput();
      document.getElementById('prodStock').value=p.stock;
      document.getElementById('prodPrecio').value=p.precio;
      document.getElementById('btnCancelarEdicionProducto').classList.remove('hidden');
    };
    window.eliminarProducto=async id=>{
      if(!confirm('¿Eliminar producto?'))return;
      await db.collection('productos').doc(id).delete();
    };
    document.getElementById('btnAgregarOpcionDiseno').addEventListener('click',()=>{
      const r=document.createElement('div');
      r.style.display='flex'; r.style.gap='8px'; r.style.marginBottom='8px';
      r.innerHTML=`
        <input type="text" class="optName" placeholder="Nombre opción" required>
        <input type="number" class="optPrice" placeholder="Precio" min="0" step="0.01" required>
        <button type="button" class="icon-btn removeOpt"><i class="ri-close-circle-line"></i></button>`;
      r.querySelector('.removeOpt').onclick=()=>r.remove();
      document.getElementById('disenoOptionsContainer').appendChild(r);
    });
    function toggleBordadoExtra(){
      document.getElementById('divBordadoExtra').classList.toggle(
        'hidden', document.getElementById('prodBordado').value!=='Sí'
      );
    }
    function toggleDisenoExtra(){
      document.getElementById('divDisenoExtra').classList.toggle(
        'hidden', document.getElementById('prodIncluyeDiseno').value!=='Sí'
      );
    }
    function toggleStockInput(){
      document.getElementById('divProdStock').classList.toggle(
        'hidden', document.getElementById('prodRastreable').value!=='Sí'
      );
    }

    // Clientes
    function listarClientes(){
      const tb=document.querySelector('#tablaClientes tbody'); tb.innerHTML='';
      clientes.forEach(c=>{
        const tr=document.createElement('tr');
        tr.innerHTML=`
          <td>${c.nombre}</td>
          <td>${c.telefono}</td>
          <td>${c.empresa||''}</td>
          <td>${c.email||''}</td>
          <td>${c.latitud},${c.longitud}</td>
          <td><button class="icon-btn" onclick="editarCliente('${c.id}')"><i class="ri-edit-line"></i></button></td>
          <td><button class="icon-btn" onclick="eliminarCliente('${c.id}')"><i class="ri-delete-bin-line"></i></button></td>`;
        tb.appendChild(tr);
      });
      if(mapClientesInit) updateClientMarkers();
    }
    document.getElementById('formCliente').addEventListener('submit',async e=>{
      e.preventDefault();
      const id=document.getElementById('cliIdEditar').value;
      const nombre=document.getElementById('cliNombre').value.trim();
      const telefono=document.getElementById('cliTelefono').value.trim();
      const empresa=document.getElementById('cliEmpresa').value.trim();
      const email=document.getElementById('cliEmail').value.trim();
      const ubic=document.getElementById('cliUbicacion').value.trim();
      const partes=ubic.split(',').map(s=>s.trim());
      if(!nombre||!telefono||partes.length!==2||isNaN(parseFloat(partes[0]))||isNaN(parseFloat(partes[1]))){
        alert('Datos cliente inválidos'); return;
      }
      const data={ nombre, telefono, empresa, email,
                   latitud:parseFloat(partes[0]), longitud:parseFloat(partes[1]) };
      if(id) await db.collection('clientes').doc(id).update(data);
      else   await db.collection('clientes').add(data);
      resetForm('formCliente'); document.getElementById('btnCancelarEdicionCliente').classList.add('hidden');
    });
    window.editarCliente=id=>{
      const c=clientes.find(x=>x.id===id); if(!c)return;
      document.getElementById('cliIdEditar').value=id;
      document.getElementById('cliNombre').value=c.nombre;
      document.getElementById('cliTelefono').value=c.telefono;
      document.getElementById('cliEmpresa').value=c.empresa;
      document.getElementById('cliEmail').value=c.email;
      document.getElementById('cliUbicacion').value=`${c.latitud},${c.longitud}`;
      document.getElementById('btnCancelarEdicionCliente').classList.remove('hidden');
    };
    window.eliminarCliente=async id=>{
      if(!confirm('¿Eliminar cliente?'))return;
      await db.collection('clientes').doc(id).delete();
    };
    document.getElementById('btnCancelarEdicionCliente').addEventListener('click',()=>{
      resetForm('formCliente');
      document.getElementById('btnCancelarEdicionCliente').classList.add('hidden');
    });

    // Autocomplete
    function bindClientSearch(){
      const inp=document.getElementById('pedidoClienteBuscador'), list=document.getElementById('autocompleteCliente');
      inp.addEventListener('input',debounce(()=>{
        const v=inp.value.trim().toLowerCase(); list.innerHTML='';
        if(!v)return;
        clientes.forEach(c=>{
          if((c.nombre+(c.empresa?` (${c.empresa})`:``)).toLowerCase().includes(v)){
            const d=document.createElement('div');
            d.className='autocomplete-item';
            d.innerHTML=`<strong>${c.nombre}</strong>${c.empresa?` (${c.empresa})`:``}`;
            d.onclick=()=>{
              inp.value=`${c.nombre}${c.empresa?` (${c.empresa})`:``}`; inp.dataset.id=c.id; list.innerHTML='';
              updatePedidoExtras();
            };
            list.appendChild(d);
          }
        });
      },250));
      document.addEventListener('click',e=>{ if(e.target!==inp) list.innerHTML=''; });
    }
    function bindProductSearch(){
      const inp=document.getElementById('pedidoProductoBuscador'), list=document.getElementById('listaProductosMatches');
      inp.addEventListener('input',debounce(()=>{
        const v=inp.value.trim().toLowerCase(); list.innerHTML='';
        if(!v)return;
        productos.forEach(p=>{
          if(p.descripcion.toLowerCase().includes(v)){
            const d=document.createElement('div');
            d.className='autocomplete-item';
            d.innerHTML=`<strong>${p.descripcion}</strong>`;
            d.onclick=()=>{
              inp.value=p.descripcion; inp.dataset.id=p.id; list.innerHTML='';
              updatePedidoExtras();
            };
            list.appendChild(d);
          }
        });
      },250));
      document.addEventListener('click',e=>{ if(e.target!==inp) list.innerHTML=''; });
    }
    function updatePedidoExtras(){
      const pid=document.getElementById('pedidoProductoBuscador').dataset.id||'';
      const prod=productos.find(p=>p.id===pid)||{};
      document.getElementById('divPedidoBordados').classList.toggle('hidden',!(prod.esBordado==='Sí'&&prod.incluyeBordadoExtra==='Sí'));
      const show=prod.incluyeDiseno==='Sí';
      document.getElementById('divPedidoDisenoIncluido').classList.toggle('hidden',!show);
      if(!show){
        document.getElementById('pedidoIncluyeDiseno').value='No';
        document.getElementById('divPedidoOpcionesDiseno').classList.add('hidden');
      }
    }
    function mostrarOpcionesDisenoPedido(){
      const pid=document.getElementById('pedidoProductoBuscador').dataset.id||'';
      const prod=productos.find(p=>p.id===pid)||{};
      const cont=document.getElementById('pedidoOpcionesDisenoContainer'); cont.innerHTML='';
      if(document.getElementById('pedidoIncluyeDiseno').value==='Sí'){
        prod.opcionesDiseno.forEach(o=>{
          const d=document.createElement('div');
          d.innerHTML=`<label><input type="checkbox" class="pedidoOpcionCheckbox" value="${o.nombre}"> ${o.nombre} ($${o.precio.toFixed(2)})</label>`;
          cont.appendChild(d);
        });
        document.getElementById('divPedidoOpcionesDiseno').classList.remove('hidden');
      }
    }

    // Pedidos
    document.getElementById('formPedido').addEventListener('submit',async e=>{
      e.preventDefault();
      const cliId=document.getElementById('pedidoClienteBuscador').dataset.id||'';
      const prodId=document.getElementById('pedidoProductoBuscador').dataset.id||'';
      const cant=parseInt(document.getElementById('pedidoCantidad').value);
      if(!cliId||!prodId||isNaN(cant)||cant<1){ alert('Datos inválidos'); return; }
      const prod=productos.find(p=>p.id===prodId)||{};
      const bord=parseInt(document.getElementById('pedidoBordados').value)||0;
      const opts=[...document.querySelectorAll('.pedidoOpcionCheckbox:checked')].map(cb=>cb.value);
      const car=document.getElementById('pedidoCaracteristicasDiseno').value.trim();
      const notas=document.getElementById('pedidoNotas').value.trim();
      const total=(prod.precio||0)*cant + bord*(prod.precioBordadoExtra||0)
            + opts.reduce((s,n)=>s + ((prod.opcionesDiseno||[]).find(o=>o.nombre===n)?.precio||0)*cant,0);
      const data={
        clienteId:cliId, productoId:prodId, cantidad:cant,
        bordadosExtra:bord, incluyeDiseno:opts.length?'Sí':'No',
        opcionesDisenoPedido:opts, caracteristicasDiseno:car, notas,
        total, estado:'En producción',
        fechaProduccion:new Date().toISOString().slice(0,10),
        fechaEntrega:'', clienteName:document.getElementById('pedidoClienteBuscador').value,
        productoDesc:document.getElementById('pedidoProductoBuscador').value
      };
      await db.collection('pedidos').add(data);
      // WA producción
      const cli=clientes.find(c=>c.id===cliId);
      if(cli?.telefono){
        const phone=cli.telefono.replace(/\D/g,'');
        const msg=`¡Hola ${cli.nombre}! Tu pedido "${data.productoDesc}" ha sido enviado a producción.`;
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`,'_blank');
      }
      resetForm('formPedido');
    });

    function setupPedidoFilters(){
      document.querySelectorAll('.pedido-filters .btn-filter').forEach(btn=>{
        btn.addEventListener('click',()=>{
          document.querySelector('.pedido-filters .btn-filter.active').classList.remove('active');
          btn.classList.add('active');
          currentFilter=btn.dataset.filter;
          renderPedidos();
        });
      });
    }

    function renderPedidos(){
      const tbody=document.querySelector('#tablaPedidos tbody'); tbody.innerHTML='';
      const hoy=new Date().toISOString().slice(0,10);
      let lista=[];
      switch(currentFilter){
        case 'produccion': lista=pedidos.filter(d=>d.estado==='En producción'); break;
        case 'listos':     lista=pedidos.filter(d=>d.estado==='Listo para entrega'); break;
        case 'entregados': lista=pedidos.filter(d=>d.estado==='Entregado'); break;
        default:           lista=pedidos;
      }
      lista.forEach(d=>{
        const tr=document.createElement('tr');
        let btns='';
        if(d.estado==='En producción'){
          btns=`<button class="btn-secondary" onclick="marcarListo('${d.id}')">Marcar listo</button>`;
        } else if(d.estado==='Listo para entrega'){
          btns=`<button class="btn-secondary" onclick="confirmarEntrega('${d.id}')">Confirmar entrega</button>`;
        } else {
          btns='✅';
        }
        tr.innerHTML=`
          <td>${d.clienteName||''}</td>
          <td>${d.productoDesc||''}</td>
          <td>${d.cantidad}</td>
          <td>$${d.total.toFixed(2)}</td>
          <td>${d.estado}</td>
          <td>${d.fechaEntrega||''}</td>
          <td>${btns}</td>`;
        tbody.appendChild(tr);
      });
      pendingListos=pedidos.filter(d=>d.estado==='Listo para entrega');
      debouncedCalcRoute();
    }
    const debouncedCalcRoute=debounce(calcularRuta,500);

    async function marcarListo(id){
      const hoy=new Date().toISOString().slice(0,10);
      await db.collection('pedidos').doc(id).update({ estado:'Listo para entrega', fechaEntrega:hoy });
      const ped=pedidos.find(p=>p.id===id), cli=clientes.find(c=>c.id===ped.clienteId);
      if(cli?.telefono){
        const phone=cli.telefono.replace(/\D/g,'');
        const msg=`¡Hola ${cli.nombre}! Tu pedido "${ped.productoDesc}" está listo para entrega el ${hoy}.`;
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`,'_blank');
      }
    }
    async function confirmarEntrega(id){
      await db.collection('pedidos').doc(id).update({ estado:'Entregado' });
      const ped=pedidos.find(p=>p.id===id), cli=clientes.find(c=>c.id===ped.clienteId);
      if(cli?.telefono){
        const phone=cli.telefono.replace(/\D/g,'');
        const msg=`¡Hola ${cli.nombre}! Tu pedido "${ped.productoDesc}" ha sido entregado. ¡Gracias!`;
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`,'_blank');
      }
    }

    // Mapas y rutas
    function initMapClientes(){
      if(mapClientesInit)return;
      mapClientes=L.map('mapClientes').setView([20,-100],5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'&copy; OpenStreetMap contributors'
      }).addTo(mapClientes);
      markersClientes=L.layerGroup().addTo(mapClientes);
      mapClientesInit=true; updateClientMarkers();
    }
    function updateClientMarkers(){
      markersClientes.clearLayers();
      clientes.forEach(c=>L.marker([c.latitud,c.longitud])
        .bindPopup(`<b>${c.nombre}</b><br>${c.empresa||''}`)
        .addTo(markersClientes));
    }
    function initMapRuta(){
      if(mapRutaInit)return;
      mapRuta=L.map('mapRuta').setView([20,-100],5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'&copy; OpenStreetMap contributors'
      }).addTo(mapRuta);
      mapRutaInit=true;
    }
    function calcularRuta(){
      if(!mapRutaInit) initMapRuta();
      if(routingControl) mapRuta.removeControl(routingControl);
      if(!pendingListos.length) return;
      const generar=origin=>{
        const destinos=pendingListos.map(p=>{
          const c=clientes.find(x=>x.id===p.clienteId);
          return L.latLng(c.latitud,c.longitud);
        });
        const waypoints=origin?[origin,...destinos]:destinos;
        routingControl=L.Routing.control({
          waypoints, routeWhileDragging:false, fitSelectedRoutes:true,
          showAlternatives:false,
          lineOptions:{ styles:[{ color:'blue',opacity:0.6,weight:4 }] },
          router:L.Routing.osrmv1({ serviceUrl:'https://router.project-osrm.org/route/v1' }),
          optimizeWaypoints:true
        }).addTo(mapRuta);
      };
      navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(pos=>generar(L.latLng(pos.coords.latitude,pos.coords.longitude)), ()=>generar(null))
        : generar(null);
    }

    // Reportes
    function actualizarReportes(){
      document.getElementById('sumProduccion').textContent=
        `En producción: ${pedidos.filter(p=>p.estado==='En producción').length}`;
      document.getElementById('sumListos').textContent=
        `Listos para entrega: ${pedidos.filter(p=>p.estado==='Listo para entrega').length}`;
      document.getElementById('sumEntregados').textContent=
        `Entregados: ${pedidos.filter(p=>p.estado==='Entregado').length}`;
    }
  </script>

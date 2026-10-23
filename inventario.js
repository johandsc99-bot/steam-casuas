/* ============================================================
   Configuración de Supabase
   Pega aquí los valores de tu proyecto:
   Supabase → Project Settings → API
     - Project URL      → SUPABASE_URL
     - anon public key  → SUPABASE_ANON_KEY
   Usa SOLO la clave "anon". Nunca pongas la "service_role" en el navegador.
   ============================================================ */
const SUPABASE_URL = "https://bosxivaaiejjtdilbhti.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_StmXwRsUuheWLFCkWiby0g_DhDbYakL";

/* ============================================================
   Panel de Inventario — lógica de la aplicación
   Persistencia:
     - "inventario_tema"     (localStorage) → preferencia de tema
     - Sesión: gestionada por Supabase Auth (ver auth.js)
     - "inventario_activos"  (localStorage) → datos del inventario
   ============================================================ */

const TEMA_KEY = "inventario_tema";
let pagina = 1;
const PAGE_SIZE = 8;
const STORAGE_KEY = "inventario_activos";

const TYPE_LABEL = { hardware: "Hardware", software: "Software", redes: "Redes" };
const ESTADOS = ["activo", "mantenimiento", "baja"];
const ESTADO_LABEL = { activo: "Activo", mantenimiento: "Mantenimiento", baja: "Baja" };

function $(sel, scope) { return (scope || document).querySelector(sel); }
function $$(sel, scope) { return Array.from((scope || document).querySelectorAll(sel)); }

/* ============================================================
   1) TEMA (claro / oscuro)
   ============================================================ */

/**
 * Devuelve el tema activo actual leído del DOM.
 */
function temaActual() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Aplica un tema al documento y sincroniza los botones de toggle
 * (icono visible + estado aria-pressed) en cualquier vista.
 */
function aplicarTema(tema) {
  document.documentElement.setAttribute("data-theme", tema);
  $$(".theme-toggle").forEach((btn) => {
    const esOscuro = tema === "dark";
    btn.setAttribute("aria-pressed", String(esOscuro));
    btn.setAttribute("aria-label", esOscuro ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
  });
}

/**
 * Alterna el tema y guarda la preferencia. Si localStorage no está
 * disponible (modo privado, cuota agotada, etc.) el tema sigue
 * funcionando para la sesión actual, solo no persiste.
 */
function alternarTema() {
  const siguiente = temaActual() === "dark" ? "light" : "dark";
  aplicarTema(siguiente);
  try {
    localStorage.setItem(TEMA_KEY, siguiente);
  } catch (error) {
    console.warn("No se pudo guardar la preferencia de tema:", error);
  }
}

/* ============================================================
   3) INVENTARIO (tabla, modales, persistencia)
   ============================================================ */

let assets = [];
let editingId = null;
let movingId = null;
let currentTypeInModal = "hardware";

/* ---------- Capa de datos: Supabase + RLS + tiempo real ---------- */
let perfil = null, todosActivos = [], tareas = [], perfiles = [];
let alcance = "yo";                       // "yo" | "todos" | uuid de otro usuario
let snapshot = new Map(), guardando = false, canal = null, recargaT = null, pollT = null, vistaActual = "dashboard";
const ROL_LABEL = { admin: "Administrador", tecnico: "Técnico", usuario: "Usuario" };
const puedeVerTodo = () => !!perfil && (perfil.rol === "admin" || perfil.rol === "tecnico");
const esAdmin = () => !!perfil && perfil.rol === "admin";

const filaDeActivo = (a) => {
  const { id, type, nombre, ubicacion, estado, problema, asignadoA, owner, ...datos } = a;
  return { id, type, nombre, ubicacion: ubicacion || null, estado, problema: problema || null, asignado_a: asignadoA || null, datos };
};
const activoDeFila = (r) => ({ ...r.datos, id: r.id, type: r.type, nombre: r.nombre, ubicacion: r.ubicacion || "",
  estado: r.estado, problema: r.problema || "", asignadoA: r.asignado_a || "", owner: r.owner_id });

function aplicarAlcance() {
  const dueno = alcance === "yo" ? usuarioActual.id : alcance;
  assets = (alcance === "todos" ? todosActivos : todosActivos.filter((a) => a.owner === dueno)).map((a) => ({ ...a }));
  snapshot = new Map(assets.map((a) => [a.id, JSON.stringify(filaDeActivo(a))]));
}

async function asegurarPerfil() {
  const { data } = await sb.from("profiles").select("id").eq("id", usuarioActual.id).maybeSingle();
  if (!data) await sb.from("profiles").insert({ id: usuarioActual.id, email: usuarioActual.email });
}

async function cargarDatos() {
  if (!sb || !usuarioActual) return;
  const [a, t, p] = await Promise.all([
    sb.from("assets").select("*").order("created_at"),
    sb.from("maintenance_tasks").select("*").order("fecha_limite", { nullsFirst: false }),
    sb.from("profiles").select("*").order("created_at"),
  ]);
  const err = a.error || t.error || p.error;
  if (err) { showToast("No se pudieron cargar los datos: " + err.message); return; }
  todosActivos = a.data.map(activoDeFila); tareas = t.data; perfiles = p.data;
  perfil = perfiles.find((x) => x.id === usuarioActual.id) || perfil;
  if (alcance !== "yo" && alcance !== "todos" && !perfiles.some((x) => x.id === alcance)) alcance = "yo";
  if (alcance !== "yo" && !puedeVerTodo()) alcance = "yo";
  aplicarAlcance();
  renderTodo();
}

/** Guarda solo lo que cambió respecto a lo cargado (upsert + delete). RLS decide si está permitido. */
async function saveAssets() {
  if (!sb || !usuarioActual) return;
  guardando = true;
  try {
    const actuales = new Map(assets.map((a) => [a.id, JSON.stringify(filaDeActivo(a))]));
    const cambios = assets.filter((a) => snapshot.get(a.id) !== actuales.get(a.id)).map(filaDeActivo);
    const borrados = [...snapshot.keys()].filter((id) => !actuales.has(id));
    if (cambios.length) { const { error } = await sb.from("assets").upsert(cambios); if (error) throw error; }
    if (borrados.length) { const { error } = await sb.from("assets").delete().in("id", borrados); if (error) throw error; }
  } catch (e) {
    showToast("No se pudo guardar: " + (e.message || "sin permisos"));
  } finally {
    guardando = false;
    await cargarDatos();
  }
}

function marcarEnVivo(ok) {
  const d = $("#liveDot");
  d.classList.toggle("on", ok);
  d.title = ok ? "Sincronizado en tiempo real" : "Sincronización periódica (cada 20 s)";
}
function programarRecarga() { if (guardando) return; clearTimeout(recargaT); recargaT = setTimeout(cargarDatos, 400); }
function detenerRealtime() {
  if (canal) { const c = canal; canal = null; sb.removeChannel(c); }
  clearInterval(pollT); clearTimeout(recargaT); marcarEnVivo(false);
}
function iniciarRealtime() {
  detenerRealtime();
  canal = sb.channel("inv-" + usuarioActual.id);
  ["assets", "maintenance_tasks", "profiles"].forEach((t) =>
    canal.on("postgres_changes", { event: "*", schema: "public", table: t }, programarRecarga));
  canal.subscribe((estado) => {
    if (!canal) return;
    const ok = estado === "SUBSCRIBED";
    marcarEnVivo(ok); clearInterval(pollT);
    if (!ok) pollT = setInterval(cargarDatos, 20000);   // respaldo por polling
  });
}

function uid(type) {
  const prefix = { hardware: "hw", software: "sw", redes: "net" }[type];
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 2200);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function detailSummary(asset) {
  if (asset.type === "hardware") {
    return `${escapeHtml(asset.marca || "")} ${escapeHtml(asset.modelo || "")} · <span class="asset-meta">S/N ${escapeHtml(asset.numeroSerie || "—")}</span>`;
  }
  if (asset.type === "software") {
    return `v${escapeHtml(asset.version || "—")} · <span class="asset-meta">Lic. ${escapeHtml(asset.licencia || "—")}</span>`;
  }
  return `${escapeHtml(asset.tipoDispositivo || "Dispositivo")} · <span class="asset-meta">${escapeHtml(asset.direccionIP || "—")}</span>`;
}

function applyFilters(list) {
  const q = $("#buscador").value.trim().toLowerCase();
  const type = $("#filtroTipo").value;
  const estado = $("#filtroEstado").value;
  const ubic = $("#filtroUbicacion").value;

  return list.filter((a) => {
    if (type !== "todos" && a.type !== type) return false;
    if (ubic !== "todos" && a.ubicacion !== ubic) return false;
    if (estado === "problema") { if (!a.problema) return false; }
    else if (estado !== "todos" && a.estado !== estado) return false;
    if (!q) return true;
    const haystack = [
      a.nombre, a.ubicacion, a.marca, a.modelo, a.numeroSerie,
      a.licencia, a.direccionIP, a.direccionMAC, a.asignadoA, a.problema,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function renderCounters() {
  const counts = { hardware: 0, software: 0, redes: 0 };
  assets.forEach((a) => counts[a.type]++);
  $("#counters").innerHTML = `
    <span class="counter-chip"><span class="dot dot-hardware"></span>Hardware <strong>${counts.hardware}</strong></span>
    <span class="counter-chip"><span class="dot dot-software"></span>Software <strong>${counts.software}</strong></span>
    <span class="counter-chip"><span class="dot dot-redes"></span>Redes <strong>${counts.redes}</strong></span>
    <span class="counter-chip">Total <strong>${assets.length}</strong></span>
    <span class="counter-chip">Con problemas <strong>${assets.filter((a) => a.problema).length}</strong></span>
  `;
}

function renderTable() {
  renderDashboard();
  refrescarDetalle();
  const tbody = $("#tablaActivos tbody");
  renderUbicaciones();
  const todos = applyFilters(assets);
  const paginas = Math.max(1, Math.ceil(todos.length / PAGE_SIZE));
  if (pagina > paginas) pagina = paginas;
  const visibles = todos.slice((pagina - 1) * PAGE_SIZE, pagina * PAGE_SIZE);
  renderPaginacion(todos.length, paginas);

  if (visibles.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="empty-state">
          <strong>No hay activos que coincidan</strong>
          Ajusta la búsqueda o los filtros, o registra un nuevo activo.
        </div>
      </td></tr>`;
    renderCounters();
    return;
  }

  tbody.innerHTML = visibles.map((a) => `
    <tr data-id="${a.id}">
      <td data-label="ID"><span class="asset-meta">${a.id}</span></td>
      <td data-label="Equipo"><div class="asset-name">${escapeHtml(a.nombre)}</div><div class="asset-sub">${detailSummary(a)}</div></td>
      <td data-label="Tipo"><span class="type-badge ${a.type}">${TYPE_LABEL[a.type]}</span></td>
      <td data-label="Usuario">${escapeHtml(a.asignadoA || "—")}</td>
      <td data-label="Ubicación">${escapeHtml(a.ubicacion || "—")}</td>
      <td data-label="Estado"><span class="status-badge ${a.problema ? "baja" : a.estado}"${a.problema ? ` title="${escapeHtml(a.problema)}"` : ""}>${a.problema ? "Con problemas" : ESTADO_LABEL[a.estado]}</span></td>
      <td data-label="Acciones"><div class="actions-cell">
        <button class="icon-btn action-ver" data-action="ver" data-id="${a.id}" title="Ver" aria-label="Ver"><svg class="i" aria-hidden="true"><use href="#i-eye"/></svg></button>
        <button class="icon-btn action-editar" data-action="editar" data-id="${a.id}" title="Editar" aria-label="Editar"><svg class="i" aria-hidden="true"><use href="#i-edit"/></svg></button>
        <button class="icon-btn action-mover" data-action="mover" data-id="${a.id}" title="Mover" aria-label="Mover"><svg class="i" aria-hidden="true"><use href="#i-pin"/></svg></button>
        <button class="icon-btn action-eliminar" data-action="eliminar" data-id="${a.id}" title="Eliminar" aria-label="Eliminar"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>
      </div></td>
    </tr>
  `).join("");

  renderCounters();
}

const DYNAMIC_TEMPLATES = {
  hardware: (a = {}) => `
    <span class="section-label">Especificaciones de hardware</span>
    <div class="form-grid">
      <div class="field">
        <label for="f-marca">Marca *</label>
        <input id="f-marca" name="marca" value="${escapeHtml(a.marca || "")}" required>
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-modelo">Modelo *</label>
        <input id="f-modelo" name="modelo" value="${escapeHtml(a.modelo || "")}" required>
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-serie">Número de serie *</label>
        <input id="f-serie" name="numeroSerie" class="mono" value="${escapeHtml(a.numeroSerie || "")}" required>
        <div class="error-text"></div>
      </div>
      <div class="field full">
        <label for="f-specs">Especificaciones (RAM, almacenamiento, CPU...)</label>
        <input id="f-specs" name="especificaciones" value="${escapeHtml(a.especificaciones || "")}">
        <div class="error-text"></div>
      </div>
    </div>
  `,
  software: (a = {}) => `
    <span class="section-label">Detalles de la licencia</span>
    <div class="form-grid">
      <div class="field">
        <label for="f-version">Versión *</label>
        <input id="f-version" name="version" value="${escapeHtml(a.version || "")}" required>
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-licencia">Clave de licencia *</label>
        <input id="f-licencia" name="licencia" class="mono" value="${escapeHtml(a.licencia || "")}" required>
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-asignado">Asignado a</label>
        <input id="f-asignado" name="asignadoA" value="${escapeHtml(a.asignadoA || "")}">
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-vencimiento">Fecha de vencimiento</label>
        <input id="f-vencimiento" name="fechaVencimiento" type="date" value="${a.fechaVencimiento || ""}">
        <div class="error-text"></div>
      </div>
    </div>
  `,
  redes: (a = {}) => `
    <span class="section-label">Detalles de red</span>
    <div class="form-grid">
      <div class="field">
        <label for="f-tipodisp">Tipo de dispositivo *</label>
        <select id="f-tipodisp" name="tipoDispositivo" required>
          ${["Router", "Switch", "Access Point", "Firewall", "Servidor"].map((t) =>
            `<option value="${t}" ${a.tipoDispositivo === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <div class="error-text"></div>
      </div>
      <div class="field">
        <label for="f-ip">Dirección IP *</label>
        <input id="f-ip" name="direccionIP" class="mono" value="${escapeHtml(a.direccionIP || "")}" placeholder="192.168.1.1" required>
        <div class="error-text"></div>
      </div>
      <div class="field full">
        <label for="f-mac">Dirección MAC *</label>
        <input id="f-mac" name="direccionMAC" class="mono" value="${escapeHtml(a.direccionMAC || "")}" placeholder="00:1A:2B:3C:4D:5E" required>
        <div class="error-text"></div>
      </div>
    </div>
  `,
};

function renderDynamicFields(type, asset) {
  $("#camposDinamicos").innerHTML = DYNAMIC_TEMPLATES[type](asset || {});
}

function selectType(type) {
  currentTypeInModal = type;
  $$(".type-option").forEach((el) => {
    el.classList.toggle("selected", el.dataset.type === type);
  });
  renderDynamicFields(type, editingId ? assets.find((a) => a.id === editingId) : {});
}

function openEditModal(id) {
  editingId = id || null;
  const asset = id ? assets.find((a) => a.id === id) : null;

  $("#modalEditarTitulo").textContent = asset ? "Editar activo" : "Nuevo activo";
  $("#modalEditarSub").textContent = asset ? asset.id : "Completa los datos del activo";

  $("#f-nombre").value = asset?.nombre || "";
  $("#f-ubicacion").value = asset?.ubicacion || "";
  $("#f-estado").value = asset?.estado || "activo";
  $("#f-problema").value = asset?.problema || "";

  clearErrors($("#formEditar"));
  selectType(asset?.type || "hardware");

  $("#overlayEditar").classList.remove("hidden");
  $("#f-nombre").focus();
}

function closeEditModal() {
  $("#overlayEditar").classList.add("hidden");
  editingId = null;
}

function clearErrors(form) {
  $$(".error-text", form).forEach((e) => (e.textContent = ""));
  $$(".field", form).forEach((f) => f.classList.remove("has-error"));
}

function setFieldError(input, message) {
  const field = input.closest(".field");
  field.classList.add("has-error");
  field.querySelector(".error-text").textContent = message;
}

const IP_REGEX = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function validateForm() {
  const form = $("#formEditar");
  clearErrors(form);
  let valid = true;

  const nombre = $("#f-nombre");
  if (!nombre.value.trim()) { setFieldError(nombre, "El nombre es obligatorio."); valid = false; }

  const ubicacion = $("#f-ubicacion");
  if (!ubicacion.value.trim()) { setFieldError(ubicacion, "La ubicación es obligatoria."); valid = false; }

  $$("#camposDinamicos [required]").forEach((input) => {
    if (!input.value.trim()) {
      setFieldError(input, "Este campo es obligatorio.");
      valid = false;
    }
  });

  if (currentTypeInModal === "redes") {
    const ip = $("#f-ip");
    if (ip.value.trim() && !IP_REGEX.test(ip.value.trim())) {
      setFieldError(ip, "Formato de IP inválido (ej. 192.168.1.1).");
      valid = false;
    }
    const mac = $("#f-mac");
    if (mac.value.trim() && !MAC_REGEX.test(mac.value.trim())) {
      setFieldError(mac, "Formato de MAC inválido (ej. 00:1A:2B:3C:4D:5E).");
      valid = false;
    }
  }

  return valid;
}

function handleSaveAsset(e) {
  e.preventDefault();
  if (!validateForm()) return;

  const base = {
    nombre: $("#f-nombre").value.trim(),
    ubicacion: $("#f-ubicacion").value.trim(),
    estado: $("#f-estado").value,
    problema: $("#f-problema").value.trim(),
    type: currentTypeInModal,
  };

  const dynamicData = {};
  $$("#camposDinamicos [name]").forEach((input) => {
    dynamicData[input.name] = input.value.trim();
  });

  if (editingId) {
    const idx = assets.findIndex((a) => a.id === editingId);
    assets[idx] = { id: editingId, historial: assets[idx].historial, ...base, ...dynamicData };
    logHistory(assets[idx], "Datos del activo actualizados");
    showToast("Activo actualizado.");
  } else {
    const newAsset = { id: uid(currentTypeInModal), ...base, ...dynamicData };
    logHistory(newAsset, "Activo registrado en el inventario");
    assets.push(newAsset);
    showToast("Activo registrado.");
  }

  saveAssets();
  renderTable();
  closeEditModal();
}

function openMoveModal(id) {
  movingId = id;
  const asset = assets.find((a) => a.id === id);
  $("#moverNombre").textContent = asset.nombre;
  $("#f-nueva-ubicacion").value = asset.ubicacion || "";
  $("#f-nuevo-estado").value = asset.estado;
  clearErrors($("#formMover"));
  $("#overlayMover").classList.remove("hidden");
  $("#f-nueva-ubicacion").focus();
}

function closeMoveModal() {
  $("#overlayMover").classList.add("hidden");
  movingId = null;
}

function handleMoveAsset(e) {
  e.preventDefault();
  const form = $("#formMover");
  clearErrors(form);

  const ubicacionInput = $("#f-nueva-ubicacion");
  if (!ubicacionInput.value.trim()) {
    setFieldError(ubicacionInput, "Indica la nueva ubicación.");
    return;
  }

  const idx = assets.findIndex((a) => a.id === movingId);
  assets[idx].ubicacion = ubicacionInput.value.trim();
  assets[idx].estado = $("#f-nuevo-estado").value;
  logHistory(assets[idx], `Movido a ${assets[idx].ubicacion} · estado: ${ESTADO_LABEL[assets[idx].estado]}`);

  saveAssets();
  renderTable();
  closeMoveModal();
  showToast("Activo reasignado.");
}

function handleDeleteAsset(id) {
  const asset = assets.find((a) => a.id === id);
  if (!asset) return;
  const ok = confirm(`¿Eliminar "${asset.nombre}"? Esta acción no se puede deshacer.`);
  if (!ok) return;
  assets = assets.filter((a) => a.id !== id);
  saveAssets();
  renderTable();
  showToast("Activo eliminado.");
}


/** Reconstruye el filtro de ubicación con las ubicaciones existentes. */
function renderUbicaciones() {
  const select = $("#filtroUbicacion");
  const actual = select.value || "todos";
  const ubicaciones = [...new Set(assets.map((a) => a.ubicacion).filter(Boolean))]
    .sort((x, y) => x.localeCompare(y, "es"));
  select.innerHTML = '<option value="todos">Todas las ubicaciones</option>' +
    ubicaciones.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  select.value = ubicaciones.includes(actual) ? actual : "todos";
}
/* ============================================================
   Autenticación con Supabase (correo + contraseña)
   ============================================================ */
const configurado = typeof SUPABASE_URL === "string" && SUPABASE_URL.startsWith("https://")
  && !SUPABASE_URL.includes("TU-PROYECTO") && !SUPABASE_ANON_KEY.includes("TU-CLAVE");
const sb = configurado && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
let usuarioActual = null;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MENSAJES_AUTH = {
  invalid_credentials: "Correo o contraseña incorrectos.",
  email_not_confirmed: "Confirma tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.",
  user_already_exists: "Ya existe una cuenta con ese correo. Inicia sesión.",
  weak_password: "La contraseña es demasiado débil. Usa al menos 8 caracteres, con letras y números.",
  over_request_rate_limit: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  over_email_send_rate_limit: "Se enviaron demasiados correos. Espera unos minutos.",
  signup_disabled: "El registro de usuarios está desactivado en este proyecto.",
};

function traducirError(error) {
  if (error.name === "AuthRetryableFetchError" || /fetch|network/i.test(error.message || "")) {
    return "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
  }
  return MENSAJES_AUTH[error.code] || `No se pudo completar la operación: ${error.message || "error desconocido"}.`;
}

function mostrarBanner(mensaje, exito) {
  const box = $("#authBanner");
  box.textContent = mensaje;
  box.classList.toggle("ok", Boolean(exito));
  box.classList.add("show");
}
function limpiarBanner() {
  const box = $("#authBanner");
  box.classList.remove("show", "ok");
  box.textContent = "";
}

function cambiarModo(modo) {
  const login = modo === "login";
  $("#loginForm").classList.toggle("hidden", !login);
  $("#registroForm").classList.toggle("hidden", login);
  $("#tabLogin").setAttribute("aria-selected", String(login));
  $("#tabRegistro").setAttribute("aria-selected", String(!login));
  limpiarBanner();
}

function alternarPassword(btn) {
  const input = btn.closest(".password-wrap").querySelector("input");
  const oculto = input.type === "password";
  input.type = oculto ? "text" : "password";
  btn.setAttribute("aria-pressed", String(oculto));
  btn.setAttribute("aria-label", oculto ? "Ocultar contraseña" : "Mostrar contraseña");
}

/** Valida el formulario; devuelve {email, password} o null si hay errores. */
function validarAuth(form, modo) {
  clearErrors(form);
  const email = $("[name=email]", form);
  const pass = $("[name=password]", form);
  let ok = true;
  if (!EMAIL_REGEX.test(email.value.trim())) {
    setFieldError(email, "Ingresa un correo válido, por ejemplo nombre@empresa.com."); ok = false;
  }
  if (modo === "registro") {
    if (pass.value.length < 8) { setFieldError(pass, "La contraseña debe tener al menos 8 caracteres."); ok = false; }
    const confirmar = $("[name=confirmar]", form);
    if (confirmar.value !== pass.value) { setFieldError(confirmar, "Las contraseñas no coinciden."); ok = false; }
  } else if (!pass.value) {
    setFieldError(pass, "Ingresa tu contraseña."); ok = false;
  }
  if (!ok) {
    mostrarBanner("Revisa los campos marcados antes de continuar.");
    $(".has-error input", form).focus();
    return null;
  }
  return { email: email.value.trim(), password: pass.value };
}

function setCargando(boton, cargando) {
  const label = boton.querySelector(".btn-label");
  if (!boton.dataset.label) boton.dataset.label = label.textContent;
  boton.disabled = cargando;
  boton.toggleAttribute("aria-busy", cargando);
  label.textContent = cargando ? "Procesando..." : boton.dataset.label;
}

async function handleAuthSubmit(e, modo) {
  e.preventDefault();
  const form = e.currentTarget;
  limpiarBanner();
  if (!sb) { mostrarBanner("Falta configurar Supabase: completa la sección de configuración al inicio de inventario.js con tu URL y tu clave anon."); return; }
  const datos = validarAuth(form, modo);
  if (!datos) return;

  const boton = $("button[type=submit]", form);
  setCargando(boton, true);
  try {
    if (modo === "login") {
      const { error } = await sb.auth.signInWithPassword(datos);
      if (error) throw error;
      showToast("Sesión iniciada.");
    } else {
      const { data, error } = await sb.auth.signUp(datos);
      if (error) throw error;
      // Con confirmación por correo activada, un correo ya registrado no devuelve error: devuelve identities vacío.
      if (data.user && data.user.identities && data.user.identities.length === 0) throw { code: "user_already_exists" };
      if (!data.session) {
        cambiarModo("login");
        mostrarBanner("Cuenta creada. Te enviamos un correo de confirmación; ábrelo y luego inicia sesión.", true);
      }
    }
    form.reset();
  } catch (err) {
    mostrarBanner(traducirError(err));
  } finally {
    setCargando(boton, false);
  }
}

async function handleLogout() {
  if (!sb) return;
  const { error } = await sb.auth.signOut();
  if (error) { showToast("No se pudo cerrar la sesión. Inténtalo de nuevo."); return; }
  showToast("Sesión cerrada.");
}

/** Abre el cuadro de acceso en la pestaña indicada ("login" o "registro"). */
function abrirAuth(modo) {
  cambiarModo(modo);
  if (!sb) mostrarBanner("Falta configurar Supabase: completa la sección de configuración al inicio de inventario.js.");
  $("#overlayAuth").classList.remove("hidden");
  $(modo === "login" ? "#login-email" : "#reg-email").focus();
}

function cerrarAuth() {
  $("#overlayAuth").classList.add("hidden");
}

function mostrarApp(nombre) {
  cerrarAuth();
  $("#loginView").classList.add("hidden");
  window.scrollTo(0, 0);
  $("#appView").classList.remove("hidden");
  $("#sessionNombre").textContent = nombre;
  $("#sessionAvatar").textContent = nombre.trim().charAt(0).toUpperCase() || "?";
}

function mostrarLogin() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  window.scrollTo(0, 0);
}

/** Muestra la app solo con sesión válida, carga los datos del usuario y se suscribe a cambios. */
async function aplicarSesion(session) {
  if (session && usuarioActual && usuarioActual.id === session.user.id) return;
  usuarioActual = session ? session.user : null;
  if (!usuarioActual) {
    detenerRealtime();
    assets = []; todosActivos = []; tareas = []; perfiles = []; perfil = null; alcance = "yo";
    renderTable();
    mostrarLogin();
    return;
  }
  mostrarApp(usuarioActual.email);
  await asegurarPerfil();
  await cargarDatos();
  iniciarRealtime();
}

async function iniciarAuth() {
  if (!sb) {
    mostrarLogin();
    mostrarBanner("Falta configurar Supabase: completa la sección de configuración al inicio de inventario.js con la URL y la clave anon de tu proyecto.");
    return;
  }
  try {
    const { data } = await sb.auth.getSession();
    aplicarSesion(data.session);
  } catch (err) {
    mostrarLogin();
    mostrarBanner(traducirError(err));
  }
  sb.auth.onAuthStateChange((_evento, session) => aplicarSesion(session));
}
/* Punto de entrada: conecta tema, autenticación e inventario. */
document.addEventListener("DOMContentLoaded", async () => {
  aplicarTema(temaActual());
  $("#themeToggleApp").addEventListener("click", alternarTema);
  $("#themeToggleLogin").addEventListener("click", alternarTema);

  // Autenticación
  $$(".auth-tabs button").forEach((b) => b.addEventListener("click", () => cambiarModo(b.dataset.modo)));
  $("#loginForm").addEventListener("submit", (e) => handleAuthSubmit(e, "login"));
  $("#registroForm").addEventListener("submit", (e) => handleAuthSubmit(e, "registro"));
  $$(".password-toggle").forEach((b) => b.addEventListener("click", () => alternarPassword(b)));
  $("#btnLogout").addEventListener("click", handleLogout);
  $("#btnAbrirAuth").addEventListener("click", () => abrirAuth("login"));
  $$("[data-abrir-auth]").forEach((b) => b.addEventListener("click", () => abrirAuth(b.dataset.abrirAuth)));
  $("#btnCerrarAuth").addEventListener("click", cerrarAuth);
  $("#overlayAuth").addEventListener("click", (e) => { if (e.target.id === "overlayAuth") cerrarAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarAuth(); });

  // Inventario
  renderTable();

  $("#btnNuevo").addEventListener("click", () => openEditModal(null));
  $("#buscador").addEventListener("input", renderTable);
  $("#filtroTipo").addEventListener("change", renderTable);
  $("#filtroEstado").addEventListener("change", renderTable);

  $("#tablaActivos").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "editar") openEditModal(id);
    if (action === "mover") openMoveModal(id);
    if (action === "eliminar") handleDeleteAsset(id);
  });

  $$(".type-option").forEach((el) => {
    el.addEventListener("click", () => selectType(el.dataset.type));
  });

  $("#formEditar").addEventListener("submit", handleSaveAsset);
  $("#formMover").addEventListener("submit", handleMoveAsset);

  $("#btnCerrarEditar").addEventListener("click", closeEditModal);
  $("#btnCancelarEditar").addEventListener("click", closeEditModal);
  $("#overlayEditar").addEventListener("click", (e) => {
    if (e.target.id === "overlayEditar") closeEditModal();
  });

  $("#btnCerrarMover").addEventListener("click", closeMoveModal);
  $("#btnCancelarMover").addEventListener("click", closeMoveModal);
  $("#overlayMover").addEventListener("click", (e) => {
    if (e.target.id === "overlayMover") closeMoveModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeEditModal();
    closeMoveModal();
  });

  await iniciarAuth();
});

// ---------- paginación, navegación entre pantallas y pestañas ----------
function renderPaginacion(total, paginas) {
  const ini = total ? (pagina - 1) * PAGE_SIZE + 1 : 0;
  const fin = Math.min(pagina * PAGE_SIZE, total);
  let nums = "";
  for (let n = 1; n <= paginas; n++) {
    if (n === 1 || n === paginas || Math.abs(n - pagina) <= 1) nums += `<button type="button" data-pag="${n}"${n === pagina ? ' aria-current="page"' : ""}>${n}</button>`;
    else if (!nums.endsWith("…</button>")) nums += `<button type="button" disabled>…</button>`;
  }
  $("#paginacion").innerHTML = `<span>Mostrando ${ini} - ${fin} de ${total} activos</span>
    <nav aria-label="Paginación"><button type="button" data-pag="${pagina - 1}" aria-label="Anterior"${pagina === 1 ? " disabled" : ""}>‹</button>${nums}<button type="button" data-pag="${pagina + 1}" aria-label="Siguiente"${pagina >= paginas ? " disabled" : ""}>›</button></nav>`;
}
$("#paginacion").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-pag]");
  if (!b || b.disabled) return;
  pagina = Number(b.dataset.pag);
  renderTable();
});
[["#buscador", "input"], ["#filtroTipo", "change"], ["#filtroEstado", "change"], ["#filtroUbicacion", "change"]]
  .forEach(([s, ev]) => $(s).addEventListener(ev, () => { pagina = 1; }, true));
$("#btnBuscar").addEventListener("click", () => { pagina = 1; renderTable(); });
$("#filtroUbicacion").addEventListener("change", renderTable);

function showView(v) {
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  const activo = v === "detalle" ? "activos" : v;
  $$(".nav-item[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === activo));
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav) { e.preventDefault(); showView(nav.dataset.view); return; }
  if (e.target.closest(".nav-item[data-soon]")) { e.preventDefault(); showToast("Esta sección estará disponible pronto"); return; }
  const ver = e.target.closest('button[data-action="ver"]');
  if (ver) { renderDetalle(ver.dataset.id); showView("detalle"); return; }
  const tab = e.target.closest(".tabs [data-tab]");
  if (tab) {
    detalleTab = tab.dataset.tab;
    $$(".tabs [data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + tab.dataset.tab));
  }
});

// ---------- historial, dashboard dinámico y detalle de activo ----------
const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const CAT_COLORS = { hardware: "#2563eb", software: "#7c4dde", redes: "#22a06b" };
const CAT_ICON = { hardware: "pc", software: "file", redes: "net" };
let detalleId = null;
let detalleTab = "general";

function logHistory(asset, texto) {
  if (!asset.historial) asset.historial = [];
  asset.historial.push({ fecha: new Date().toISOString(), texto });
}
function fmtFecha(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function donutHTML(items, total, label) {
  let acc = 0;
  const stops = items.filter((i) => i.v > 0).map((i) => {
    const ini = (acc / total) * 100; acc += i.v;
    return `${i.c} ${ini.toFixed(2)}% ${((acc / total) * 100).toFixed(2)}%`;
  });
  const fondo = total ? `conic-gradient(${stops.join(",")})` : "conic-gradient(var(--border) 0 100%)";
  const leg = items.map((i) => `<li><i style="background:${i.c}"></i>${i.n}<b>${i.v}</b></li>`).join("");
  return `<div class="donut-row"><div class="donut" role="img" aria-label="${label}" style="--p:${fondo}"><span><b>${total}</b>activos</span></div><ul class="legend">${leg}</ul></div>`;
}

function renderDashboard() {
  const total = assets.length;
  const prob = assets.filter((a) => a.problema);
  const sinProb = assets.filter((a) => !a.problema);
  const operativos = sinProb.filter((a) => a.estado === "activo").length;
  const mant = sinProb.filter((a) => a.estado === "mantenimiento").length;
  const baja = sinProb.filter((a) => a.estado === "baja").length;

  const kpi = (c, i, l, n) => `<div class="card kpi"><span class="tile ${c}">${ic(i)}</span><div><small>${l}</small><strong>${n}</strong></div></div>`;
  const cats = ["hardware", "software", "redes"].map((t) => ({ n: TYPE_LABEL[t], v: assets.filter((a) => a.type === t).length, c: CAT_COLORS[t] }));
  const estados = [
    { n: "Operativos", v: operativos, c: "#22a06b" }, { n: "Mantenimiento", v: mant, c: "#f59e0b" },
    { n: "Con problemas", v: prob.length, c: "#dc2626" }, { n: "Baja", v: baja, c: "#94a3b8" },
  ];

  const recientes = assets.slice(-5).reverse().map((a) =>
    `<li><strong>${escapeHtml(a.id)}</strong><span>${escapeHtml(a.nombre)}</span><time>${TYPE_LABEL[a.type]}</time></li>`).join("");

  const hoy = new Date(); const limite = new Date(); limite.setDate(hoy.getDate() + 30);
  const porVencer = assets.filter((a) => a.fechaVencimiento && new Date(a.fechaVencimiento) <= limite).length;
  const sinResp = assets.filter((a) => a.type === "software" && !a.asignadoA).length;
  const al = (c, i, t, d) => `<li class="alert-item"><span class="tile ${c}">${ic(i)}</span><div><strong>${t}</strong><small>${d}</small></div></li>`;

  $("#dashboardBody").innerHTML = `
    <div class="grid kpis">${kpi("t-blue", "pc", "Total de activos", total)}${kpi("t-green", "ok", "Operativos", operativos)}${kpi("t-amber", "wrench", "En mantenimiento", mant)}${kpi("t-red", "warn", "Con problemas", prob.length)}</div>
    <div class="grid charts">
      <div class="card"><h2>Activos por categoría</h2>${donutHTML(cats, total, "Activos por categoría")}</div>
      <div class="card"><h2>Estado de los activos</h2>${donutHTML(estados, total, "Estado de los activos")}</div>
      <div class="card"><h2>Últimos registros</h2>${recientes ? `<ul class="recent">${recientes}</ul>` : '<p class="empty-note">Aún no hay activos registrados.</p>'}</div>
    </div>
    <div class="card"><h2>Alertas</h2><ul class="alerts">
      ${al("t-red", "warn", `${prob.length} ${prob.length === 1 ? "equipo presenta" : "equipos presentan"} fallas`, "Con un problema reportado.")}
      ${al("t-amber", "wrench", `${assets.filter((a) => a.estado === "mantenimiento").length} en mantenimiento`, "Activos actualmente en mantenimiento.")}
      ${al("t-blue", "shield", `${porVencer} ${porVencer === 1 ? "licencia vence" : "licencias vencen"} pronto`, "Vencidas o con menos de 30 días.")}
      ${al("t-violet", "users", `${sinResp} de software sin responsable`, "Asigna un responsable a estas licencias.")}
    </ul></div>`;
}

function renderDetalle(id) {
  const a = assets.find((x) => x.id === id);
  if (!a) { showView("activos"); return; }
  detalleId = id;
  const e = escapeHtml;
  const info = (l, v) => `<div class="info-card"><small>${l}</small><strong>${v || "—"}</strong></div>`;
  const estadoTxt = a.problema ? "Con problemas" : ESTADO_LABEL[a.estado];
  const badge = `<span class="status-badge ${a.problema ? "baja" : a.estado}">${estadoTxt}</span>`;
  const porTipo = {
    hardware: [["Marca", a.marca], ["Modelo", a.modelo], ["Número de serie", a.numeroSerie]],
    software: [["Versión", a.version], ["Licencia", a.licencia], ["Asignado a", a.asignadoA], ["Vencimiento", a.fechaVencimiento ? fmtFecha(a.fechaVencimiento + "T00:00:00") : ""]],
    redes: [["Tipo de dispositivo", a.tipoDispositivo], ["Dirección IP", a.direccionIP], ["Dirección MAC", a.direccionMAC]],
  }[a.type] || [];
  const cards = porTipo.map(([l, v]) => info(l, e(v || ""))).join("") + info("Ubicación", e(a.ubicacion || "")) + info("Estado", badge) + (a.problema ? info("Problema reportado", e(a.problema)) : "");
  const hist = (a.historial || []).slice().reverse();
  const tl = (lista) => lista.length
    ? `<ul class="timeline">${lista.map((h) => `<li><i></i><div><strong>${e(h.texto)}</strong><small>${fmtFecha(h.fecha)}</small></div></li>`).join("")}</ul>`
    : '<p class="empty-note">Aún no hay movimientos registrados.</p>';
  const sub = a.type === "hardware" ? `${e(a.marca || "")} ${e(a.modelo || "")}`.trim() : TYPE_LABEL[a.type];
  const tabs = [["general", "Información general"], ["specs", "Especificaciones"], ["hist", "Historial"], ["files", "Archivos"]];
  const panel = {
    general: `<div class="info-grid">${cards}</div>`,
    specs: a.especificaciones ? `<div class="info-grid">${info("Especificaciones", e(a.especificaciones))}</div>` : '<p class="empty-note">Sin especificaciones registradas.</p>',
    hist: tl(hist),
    files: '<p class="empty-note">Este activo no tiene archivos adjuntos.</p>',
  };
  $("#detalleBody").innerHTML = `
    <button class="btn btn-ghost back" type="button" data-view="activos">${ic("back")}Volver al inventario</button>
    <div class="card asset-head"><span class="asset-ico t-blue">${ic(CAT_ICON[a.type])}</span><div class="grow">
      <div class="title-row"><h1>${e(a.id.toUpperCase())} — ${e(a.nombre)}</h1>${badge}</div>
      <dl class="meta"><div><dt>Código de inventario</dt><dd>${e(a.id.toUpperCase())}</dd></div><div><dt>Categoría</dt><dd>${TYPE_LABEL[a.type]}</dd></div><div><dt>Marca / Modelo / Tipo</dt><dd>${sub || "—"}</dd></div><div><dt>Ubicación</dt><dd>${e(a.ubicacion || "—")}</dd></div></dl></div></div>
    <div class="card tabs-card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === detalleTab}" data-tab="${k}">${l}</button>`).join("")}</div>
      ${tabs.map(([k]) => `<div class="tab-panel${k === detalleTab ? "" : " hidden"}" id="tab-${k}">${panel[k]}</div>`).join("")}</div>
    <div class="card"><h2>Historial reciente</h2>${tl(hist.slice(0, 3))}</div>`;
}

function refrescarDetalle() {
  if (!detalleId) return;
  if (assets.some((a) => a.id === detalleId)) { renderDetalle(detalleId); return; }
  detalleId = null;
  if (!$("#view-detalle").classList.contains("hidden")) showView("activos");
}

/* ============================================================
   Módulos: cabecera, alertas, mantenimiento, ubicaciones,
   usuarios, red, reportes y configuración
   ============================================================ */
const E = (s) => escapeHtml(s == null ? "" : s);
const diasAlerta = () => Number(perfil && perfil.preferencias && perfil.preferencias.diasAlerta) || 30;
const fechaLocal = (d) => (d ? fmtFecha(d + "T00:00:00") : "—");
const hoy0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const tabla = (cols, filas, vacio) => `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${filas || `<tr><td colspan="${cols.length}" class="empty-cell">${vacio}</td></tr>`}</tbody></table></div>`;
const cabeza = (t, sub, acc) => `<div class="view-head"><div><h1>${t}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div>${acc || ""}</div>`;
const nombreDe = (id) => { const a = assets.find((x) => x.id === id); return a ? a.nombre : id; };
const iconBtn = (mod, id, n, t, extra = "") => `<button class="icon-btn" type="button" data-mod="${mod}" data-id="${E(id)}" ${extra} title="${t}" aria-label="${t}">${ic(n)}</button>`;

function renderTodo() {
  renderTable();       // también refresca dashboard y detalle
  renderCabecera();
  renderModulos();
}

/* ---------- cabecera: usuario, selector de alcance y campana ---------- */
const leidasKey = () => `alertas_leidas_${usuarioActual.id}`;
const leidas = () => { try { return new Set(JSON.parse(localStorage.getItem(leidasKey()) || "[]")); } catch { return new Set(); } };
function guardarLeidas(set) { try { localStorage.setItem(leidasKey(), JSON.stringify([...set])); } catch { /* sin almacenamiento */ } }

function renderCabecera() {
  if (!usuarioActual) return;
  const nombre = (perfil && perfil.nombre) || usuarioActual.email.split("@")[0];
  $("#userNombre").textContent = nombre;
  $("#userRol").textContent = ROL_LABEL[(perfil && perfil.rol) || "usuario"];
  $("#userAvatar").textContent = nombre.trim().slice(0, 2).toUpperCase();
  $("#bienvenidaNombre").textContent = nombre.split(" ")[0];
  const sel = $("#verComo");
  sel.classList.toggle("hidden", !puedeVerTodo());
  if (puedeVerTodo()) {
    const opts = `<option value="yo">Mi inventario</option><option value="todos">Todos los usuarios</option>` +
      perfiles.filter((p) => p.id !== usuarioActual.id).map((p) => `<option value="${p.id}">${E(p.nombre || p.email)}</option>`).join("");
    if (sel.dataset.h !== opts) { sel.innerHTML = opts; sel.dataset.h = opts; }
    sel.value = alcance;
  }
  const l = leidas(); const n = calcularAlertas().filter((a) => !l.has(a.k)).length;
  const dot = $("#campanaDot"); dot.textContent = n > 9 ? "9+" : n; dot.classList.toggle("hidden", !n);
}

/* ---------- alertas (calculadas en vivo a partir de los datos) ---------- */
function calcularAlertas() {
  const hoy = hoy0(), lim = new Date(hoy); lim.setDate(lim.getDate() + diasAlerta());
  const out = [];
  const add = (k, sev, ico, t, d, id) => out.push({ k, sev, ico, t, d, id });
  assets.filter((a) => a.problema).forEach((a) => add("p-" + a.id, "red", "warn", `${a.nombre} presenta un problema`, a.problema, a.id));
  tareas.filter((t) => t.estado !== "completado" && t.fecha_limite && assets.some((a) => a.id === t.asset_id)).forEach((t) => {
    const f = new Date(t.fecha_limite + "T00:00:00");
    if (f < hoy) add("tv-" + t.id, "red", "wrench", `Mantenimiento vencido: ${t.titulo}`, `${nombreDe(t.asset_id)} · límite ${fechaLocal(t.fecha_limite)}`, t.asset_id);
    else if (f <= lim) add("tp-" + t.id, "amber", "wrench", `Mantenimiento próximo: ${t.titulo}`, `${nombreDe(t.asset_id)} · límite ${fechaLocal(t.fecha_limite)}`, t.asset_id);
  });
  assets.filter((a) => a.fechaVencimiento).forEach((a) => {
    const f = new Date(a.fechaVencimiento + "T00:00:00");
    if (f < hoy) add("lv-" + a.id, "red", "shield", `Licencia vencida: ${a.nombre}`, `Venció el ${fechaLocal(a.fechaVencimiento)}`, a.id);
    else if (f <= lim) add("lp-" + a.id, "amber", "shield", `Licencia por vencer: ${a.nombre}`, `Vence el ${fechaLocal(a.fechaVencimiento)}`, a.id);
  });
  assets.filter((a) => a.type === "software" && !a.asignadoA).forEach((a) => add("sr-" + a.id, "violet", "users", `${a.nombre} sin responsable`, "Asigna un responsable a esta licencia.", a.id));
  const dup = duplicadosRed();
  assets.filter((a) => a.type === "redes" && (dup.ip.has(a.direccionIP) || dup.mac.has((a.direccionMAC || "").toUpperCase())))
    .forEach((a) => add("d-" + a.id, "amber", "net", `${a.nombre}: IP o MAC duplicada`, `${a.direccionIP || "—"} · ${a.direccionMAC || "—"}`, a.id));
  return out;
}
const t_sev = { red: "t-red", amber: "t-amber", violet: "t-violet" };
function renderAlertas() {
  const l = leidas(), lista = calcularAlertas();
  const nuevas = lista.filter((a) => !l.has(a.k)).length;
  const items = lista.map((a) => `<li class="alert-item${l.has(a.k) ? " leida" : ""}"><span class="tile ${t_sev[a.sev]}">${ic(a.ico)}</span><div class="grow"><strong>${E(a.t)}</strong><small>${E(a.d)}</small></div>
    <button class="btn btn-ghost btn-sm" type="button" data-action="ver" data-id="${E(a.id)}">Ver activo</button>
    ${l.has(a.k) ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-mod="alerta-leer" data-val="${E(a.k)}">Marcar leída</button>`}</li>`).join("");
  $("#body-alertas").innerHTML = cabeza("Alertas", `${nuevas} sin leer · avisos con ${diasAlerta()} días de anticipación (ajustable en Configuración).`,
    nuevas ? `<button class="btn btn-primary" type="button" data-mod="alertas-todas">Marcar todas como leídas</button>` : "") +
    (lista.length ? `<div class="card"><ul class="alerts lista">${items}</ul></div>` : `<div class="card empty-note">Todo en orden: no hay alertas activas.</div>`);
}

/* ---------- formulario genérico en modal ---------- */
let formAccion = null;
function abrirForm(titulo, campos, onSubmit) {
  $("#formTitulo").textContent = titulo; $("#formError").textContent = "";
  $("#formCampos").innerHTML = campos.map((c) => {
    const ctl = c.tipo === "select" ? `<select id="g-${c.id}">${c.opciones.map(([v, t]) => `<option value="${E(v)}">${E(t)}</option>`).join("")}</select>`
      : c.tipo === "textarea" ? `<textarea id="g-${c.id}" rows="3"></textarea>` : `<input id="g-${c.id}" type="${c.tipo || "text"}" value="${E(c.valor || "")}">`;
    return `<div class="field full"><label for="g-${c.id}">${c.label}${c.req ? " *" : ""}</label>${ctl}</div>`;
  }).join("");
  formAccion = { campos, onSubmit };
  $("#overlayForm").classList.remove("hidden");
  const p = $("#formCampos input, #formCampos select"); if (p) p.focus();
}
function cerrarForm() { $("#overlayForm").classList.add("hidden"); formAccion = null; }
const okSb = (r) => { if (r.error) { showToast(r.error.message); return false; } return true; };

/* ---------- mantenimiento ---------- */
let mantTab = "pendiente";
function renderMantenimiento() {
  const hoy = hoy0(), lista = tareas.filter((t) => assets.some((a) => a.id === t.asset_id));
  const tabs = [["pendiente", "Pendientes"], ["en_proceso", "En proceso"], ["completado", "Completadas"]];
  const filas = lista.filter((t) => t.estado === mantTab).map((t) => {
    const venc = t.estado !== "completado" && t.fecha_limite && new Date(t.fecha_limite + "T00:00:00") < hoy;
    const sig = { pendiente: ["en_proceso", "Iniciar"], en_proceso: ["completado", "Completar"] }[t.estado];
    return `<tr><td data-label="Activo"><div class="asset-name">${E(nombreDe(t.asset_id))}</div><div class="asset-sub">${E(t.asset_id)}</div></td>
      <td data-label="Tarea">${E(t.titulo)}${t.notas ? `<div class="asset-sub">${E(t.notas)}</div>` : ""}</td>
      <td data-label="Tipo">${t.tipo === "correctivo" ? "Correctivo" : "Preventivo"}</td>
      <td data-label="Fecha límite">${fechaLocal(t.fecha_limite)}${venc ? ' <span class="status-badge baja">Vencida</span>' : ""}</td>
      <td data-label="Acciones"><div class="actions-cell">${sig ? `<button class="btn btn-ghost btn-sm" type="button" data-mod="tarea-estado" data-id="${t.id}" data-val="${sig[0]}">${sig[1]}</button>` : ""}${iconBtn("tarea-del", t.id, "trash", "Eliminar")}</div></td></tr>`;
  }).join("");
  $("#body-mant").innerHTML = cabeza("Mantenimiento", "Tareas preventivas y correctivas de tus activos.", `<button class="btn btn-primary" type="button" data-mod="tarea-nueva">+ Nueva tarea</button>`) +
    `<div class="card tabs-card"><div class="tabs">${tabs.map(([k, l]) => `<button type="button" aria-selected="${k === mantTab}" data-mod="mt" data-val="${k}">${l} (${lista.filter((t) => t.estado === k).length})</button>`).join("")}</div>${tabla(["Activo", "Tarea", "Tipo", "Fecha límite", "Acciones"], filas, "No hay tareas en esta lista.")}</div>`;
}
function nuevaTarea() {
  if (!assets.length) { showToast("Primero registra un activo."); return; }
  abrirForm("Nueva tarea de mantenimiento", [
    { id: "asset", label: "Activo", tipo: "select", opciones: assets.map((a) => [a.id, `${a.nombre} (${a.id})`]) },
    { id: "titulo", label: "Tarea", req: true },
    { id: "tipo", label: "Tipo", tipo: "select", opciones: [["preventivo", "Preventivo"], ["correctivo", "Correctivo"]] },
    { id: "fecha", label: "Fecha límite", tipo: "date" },
    { id: "notas", label: "Notas", tipo: "textarea" },
  ], async (v) => {
    const r = await sb.from("maintenance_tasks").insert({ asset_id: v.asset, titulo: v.titulo, tipo: v.tipo, fecha_limite: v.fecha || null, notas: v.notas || null });
    if (okSb(r)) { showToast("Tarea creada."); await cargarDatos(); return true; }
  });
}
async function cambiarEstadoTarea(id, estado) {
  if (!okSb(await sb.from("maintenance_tasks").update({ estado }).eq("id", id))) return;
  const t = tareas.find((x) => x.id === id), a = t && assets.find((x) => x.id === t.asset_id);
  if (estado === "completado" && a) { logHistory(a, `Mantenimiento completado: ${t.titulo}`); await saveAssets(); } else await cargarDatos();
}

/* ---------- ubicaciones ---------- */
let ubicSel = null;
function renderUbicacionesMod() {
  const g = new Map();
  assets.forEach((a) => { const k = a.ubicacion || "Sin ubicación"; if (!g.has(k)) g.set(k, []); g.get(k).push(a); });
  const nombres = [...g.keys()].sort((x, y) => x.localeCompare(y, "es"));
  if (!g.has(ubicSel)) ubicSel = nombres[0] || null;
  const izq = nombres.map((n) => `<button type="button" class="ub-item${n === ubicSel ? " sel" : ""}" data-mod="ubic-sel" data-val="${E(n)}"><strong>${E(n)}</strong><small>${g.get(n).length} activos${g.get(n).some((a) => a.problema) ? " · con problemas" : ""}</small></button>`).join("");
  const filas = (g.get(ubicSel) || []).map((a) => `<tr><td data-label="ID"><span class="asset-meta">${E(a.id)}</span></td><td data-label="Equipo">${E(a.nombre)}</td><td data-label="Tipo">${TYPE_LABEL[a.type]}</td>
    <td data-label="Acciones"><div class="actions-cell">${iconBtn("mover", a.id, "pin", "Mover a otra ubicación")}</div></td></tr>`).join("");
  $("#body-ubic").innerHTML = cabeza("Ubicaciones", "Dónde está cada activo. Renombra una ubicación o mueve activos.") +
    (nombres.length ? `<div class="mod-grid"><div class="card ub-list">${izq}</div><div class="card"><div class="view-head"><h2>${E(ubicSel)}</h2><button class="btn btn-ghost btn-sm" type="button" data-mod="ubic-ren">Renombrar</button></div>${tabla(["ID", "Equipo", "Tipo", "Acciones"], filas, "")}</div></div>` : `<div class="card empty-note">Aún no hay activos con ubicación.</div>`);
}
function renombrarUbicacion() {
  const ids = assets.filter((a) => (a.ubicacion || "Sin ubicación") === ubicSel).map((a) => a.id);
  abrirForm(`Renombrar «${ubicSel}»`, [{ id: "nombre", label: "Nuevo nombre", req: true, valor: ubicSel === "Sin ubicación" ? "" : ubicSel }], async (v) => {
    if (okSb(await sb.from("assets").update({ ubicacion: v.nombre }).in("id", ids))) { ubicSel = v.nombre; showToast("Ubicación actualizada."); await cargarDatos(); return true; }
  });
}

/* ---------- usuarios ---------- */
function renderUsuarios() {
  const cuenta = (id) => todosActivos.filter((a) => a.owner === id).length;
  const lista = puedeVerTodo() ? perfiles : perfiles.filter((p) => p.id === usuarioActual.id);
  const filas = lista.map((p) => `<tr><td data-label="Usuario"><div class="asset-name">${E(p.nombre || p.email)}</div><div class="asset-sub">${E(p.email)}</div></td>
    <td data-label="Rol">${esAdmin() && p.id !== usuarioActual.id ? `<select data-mod-sel="rol" data-id="${p.id}">${Object.entries(ROL_LABEL).map(([v, t]) => `<option value="${v}"${p.rol === v ? " selected" : ""}>${t}</option>`).join("")}</select>` : `<span class="type-badge hardware">${ROL_LABEL[p.rol]}</span>`}</td>
    <td data-label="Activos">${cuenta(p.id)}</td>
    <td data-label="Acciones">${p.id !== usuarioActual.id && puedeVerTodo() ? `<button class="btn btn-ghost btn-sm" type="button" data-mod="ver-usuario" data-id="${p.id}">Ver inventario</button>` : ""}</td></tr>`).join("");
  $("#body-usuarios").innerHTML = cabeza("Usuarios", esAdmin() ? "Administra roles y consulta el inventario de cada usuario." : puedeVerTodo() ? "Puedes consultar el inventario de otros usuarios; solo un administrador cambia roles." : "Solo administradores y técnicos pueden ver a otros usuarios.") +
    tabla(["Usuario", "Rol", "Activos", "Acciones"], filas, "Sin usuarios.");
}

/* ---------- red ---------- */
function duplicadosRed() {
  const cuenta = (campo, norm) => { const m = new Map(); assets.filter((a) => a.type === "redes" && a[campo]).forEach((a) => { const k = norm(a[campo]); m.set(k, (m.get(k) || 0) + 1); }); return new Set([...m].filter(([, n]) => n > 1).map(([k]) => k)); };
  return { ip: cuenta("direccionIP", (x) => x), mac: cuenta("direccionMAC", (x) => x.toUpperCase()) };
}
function renderRed() {
  const redes = assets.filter((a) => a.type === "redes"), dup = duplicadosRed();
  const esDup = (a) => dup.ip.has(a.direccionIP) || dup.mac.has((a.direccionMAC || "").toUpperCase());
  const kpi = (c, i, l, n) => `<div class="card kpi"><span class="tile ${c}">${ic(i)}</span><div><small>${l}</small><strong>${n}</strong></div></div>`;
  const filas = redes.map((a) => `<tr><td data-label="Dispositivo"><div class="asset-name">${E(a.nombre)}</div><div class="asset-sub">${E(a.id)}</div></td><td data-label="Tipo">${E(a.tipoDispositivo || "—")}</td>
    <td data-label="IP"><span class="asset-meta">${E(a.direccionIP || "—")}</span></td><td data-label="MAC"><span class="asset-meta">${E(a.direccionMAC || "—")}</span></td><td data-label="Ubicación">${E(a.ubicacion || "—")}</td>
    <td data-label="Estado"><span class="status-badge ${a.problema ? "baja" : a.estado}">${a.problema ? "Con problemas" : ESTADO_LABEL[a.estado]}</span>${esDup(a) ? ' <span class="status-badge mantenimiento">IP/MAC duplicada</span>' : ""}</td>
    <td data-label="Acciones"><div class="actions-cell">${iconBtn("ver", a.id, "eye", "Ver").replace('data-mod="ver"', 'data-action="ver"')}${iconBtn("editar", a.id, "edit", "Editar")}</div></td></tr>`).join("");
  $("#body-red").innerHTML = cabeza("Red", "Dispositivos de red, direcciones y conflictos.", `<button class="btn btn-primary" type="button" data-mod="red-nuevo">+ Nuevo dispositivo</button>`) +
    `<div class="grid kpis">${kpi("t-blue", "net", "Dispositivos de red", redes.length)}${kpi("t-amber", "warn", "IP/MAC duplicadas", redes.filter(esDup).length)}${kpi("t-red", "wrench", "Con problemas", redes.filter((a) => a.problema).length)}</div>` +
    tabla(["Dispositivo", "Tipo", "IP", "MAC", "Ubicación", "Estado", "Acciones"], filas, "No hay dispositivos de red registrados.");
}

/* ---------- reportes ---------- */
let repSel = "completo";
const estadoTxt = (a) => (a.problema ? "Con problemas" : ESTADO_LABEL[a.estado]);
const REPORTES = {
  completo: { t: "Inventario completo", cols: ["ID", "Equipo", "Tipo", "Usuario", "Ubicación", "Estado"], rows: () => assets.map((a) => [a.id, a.nombre, TYPE_LABEL[a.type], a.asignadoA || "", a.ubicacion || "", estadoTxt(a)]) },
  estado: { t: "Resumen por estado", cols: ["Estado", "Cantidad"], rows: () => ["Activo", "Mantenimiento", "Baja", "Con problemas"].map((e) => [e, assets.filter((a) => estadoTxt(a) === e).length]) },
  ubicacion: { t: "Activos por ubicación", cols: ["Ubicación", "Total", "Con problemas"], rows: () => [...new Set(assets.map((a) => a.ubicacion || "Sin ubicación"))].sort().map((u) => { const l = assets.filter((a) => (a.ubicacion || "Sin ubicación") === u); return [u, l.length, l.filter((a) => a.problema).length]; }) },
  problemas: { t: "Equipos con problemas", cols: ["ID", "Equipo", "Ubicación", "Problema"], rows: () => assets.filter((a) => a.problema).map((a) => [a.id, a.nombre, a.ubicacion || "", a.problema]) },
  mantenimiento: { t: "Tareas de mantenimiento", cols: ["Activo", "Tarea", "Tipo", "Fecha límite", "Estado"], rows: () => tareas.filter((t) => assets.some((a) => a.id === t.asset_id)).map((t) => [nombreDe(t.asset_id), t.titulo, t.tipo, t.fecha_limite || "", t.estado]) },
};
function renderReportes() {
  const r = REPORTES[repSel], filas = r.rows();
  $("#body-reportes").innerHTML = cabeza("Reportes", "Genera, exporta e imprime reportes con los datos actuales.",
    `<div class="rep-acc"><button class="btn btn-ghost" type="button" data-mod="rep-print">Imprimir</button><button class="btn btn-primary" type="button" data-mod="rep-csv">Exportar CSV</button></div>`) +
    `<div class="card filters"><label class="grow">Reporte <select id="repSel">${Object.entries(REPORTES).map(([k, v]) => `<option value="${k}"${k === repSel ? " selected" : ""}>${v.t}</option>`).join("")}</select></label><span class="sub" style="margin:0">${filas.length} filas</span></div>` +
    tabla(r.cols, filas.map((f) => `<tr>${f.map((c, i) => `<td data-label="${r.cols[i]}">${E(c)}</td>`).join("")}</tr>`).join(""), "Sin datos para este reporte.");
}
function exportarCSV() {
  const r = REPORTES[repSel];
  const celda = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = "\ufeff" + [r.cols, ...r.rows()].map((f) => f.map(celda).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `reporte-${repSel}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

/* ---------- configuración ---------- */
function renderConfig() {
  $("#body-config").innerHTML = cabeza("Configuración", "Tu perfil y preferencias del sistema.") + `<div class="grid charts">
    <form class="card" id="formPerfil" novalidate><h2>Perfil</h2>
      <div class="field"><label for="c-email">Correo</label><input id="c-email" value="${E(usuarioActual.email)}" disabled></div>
      <div class="field"><label for="c-rol">Rol</label><input id="c-rol" value="${ROL_LABEL[(perfil && perfil.rol) || "usuario"]}" disabled></div>
      <div class="field"><label for="c-nombre">Nombre para mostrar</label><input id="c-nombre" maxlength="60" value="${E(perfil && perfil.nombre)}"></div>
      <div class="field"><label for="c-dias">Avisar con (días de anticipación)</label><input id="c-dias" type="number" min="1" max="365" value="${diasAlerta()}"></div>
      <button class="btn btn-primary" type="submit">Guardar cambios</button></form>
    <form class="card" id="formPass" novalidate><h2>Cambiar contraseña</h2>
      <div class="field"><label for="c-p1">Nueva contraseña</label><input id="c-p1" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="field"><label for="c-p2">Repetir contraseña</label><input id="c-p2" type="password" autocomplete="new-password"></div>
      <div class="error-text" id="passError" role="alert"></div>
      <button class="btn btn-primary" type="submit">Actualizar contraseña</button></form></div>`;
}

/* ---------- despacho y eventos ---------- */
const MODULOS = { mant: renderMantenimiento, ubic: renderUbicacionesMod, usuarios: renderUsuarios, red: renderRed, reportes: renderReportes, alertas: renderAlertas, config: renderConfig };
function renderModulos() { if (usuarioActual && MODULOS[vistaActual]) MODULOS[vistaActual](); }
const _showView = showView;
showView = function (v) { vistaActual = v; _showView(v); renderModulos(); };

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-mod]");
  if (!b) return;
  const { mod, id, val } = b.dataset;
  if (mod === "mt") { mantTab = val; renderMantenimiento(); }
  else if (mod === "tarea-nueva") nuevaTarea();
  else if (mod === "tarea-estado") await cambiarEstadoTarea(id, val);
  else if (mod === "tarea-del") { if (confirm("¿Eliminar esta tarea?") && okSb(await sb.from("maintenance_tasks").delete().eq("id", id))) await cargarDatos(); }
  else if (mod === "ubic-sel") { ubicSel = val; renderUbicacionesMod(); }
  else if (mod === "ubic-ren") renombrarUbicacion();
  else if (mod === "mover") openMoveModal(id);
  else if (mod === "editar") openEditModal(id);
  else if (mod === "red-nuevo") { openEditModal(null); selectType("redes"); }
  else if (mod === "ver-usuario") { alcance = id; aplicarAlcance(); renderTodo(); showView("activos"); }
  else if (mod === "rep-csv") exportarCSV();
  else if (mod === "rep-print") window.print();
  else if (mod === "alerta-leer") { const s = leidas(); s.add(val); guardarLeidas(s); renderCabecera(); renderAlertas(); }
  else if (mod === "alertas-todas") { guardarLeidas(new Set(calcularAlertas().map((a) => a.k))); renderCabecera(); renderAlertas(); }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "repSel") { repSel = t.value; renderReportes(); }
  else if (t.id === "verComo") { alcance = t.value; aplicarAlcance(); pagina = 1; renderTodo(); }
  else if (t.matches('select[data-mod-sel="rol"]')) {
    if (okSb(await sb.from("profiles").update({ rol: t.value }).eq("id", t.dataset.id))) { showToast("Rol actualizado."); await cargarDatos(); }
    else await cargarDatos();
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id === "formGenerico") {
    e.preventDefault();
    if (!formAccion) return;
    const v = {}; let falta = false;
    formAccion.campos.forEach((c) => { v[c.id] = $("#g-" + c.id).value.trim(); if (c.req && !v[c.id]) falta = true; });
    if (falta) { $("#formError").textContent = "Completa los campos obligatorios."; return; }
    if (await formAccion.onSubmit(v)) cerrarForm();
  } else if (f.id === "formPerfil") {
    e.preventDefault();
    const dias = Math.min(365, Math.max(1, parseInt($("#c-dias").value, 10) || 30));
    const prefs = { ...(perfil && perfil.preferencias), diasAlerta: dias };
    if (okSb(await sb.from("profiles").update({ nombre: $("#c-nombre").value.trim() || null, preferencias: prefs }).eq("id", usuarioActual.id))) { showToast("Configuración guardada."); await cargarDatos(); }
  } else if (f.id === "formPass") {
    e.preventDefault();
    const p1 = $("#c-p1").value, p2 = $("#c-p2").value, err = $("#passError");
    if (p1.length < 8) { err.textContent = "Usa al menos 8 caracteres."; return; }
    if (p1 !== p2) { err.textContent = "Las contraseñas no coinciden."; return; }
    err.textContent = "";
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) err.textContent = traducirError(error); else { showToast("Contraseña actualizada."); f.reset(); }
  }
});

$("#btnCerrarForm").addEventListener("click", cerrarForm);
$("#btnCancelarForm").addEventListener("click", cerrarForm);
$("#overlayForm").addEventListener("click", (e) => { if (e.target.id === "overlayForm") cerrarForm(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarForm(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && usuarioActual) cargarDatos(); });
$("#topBuscar").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  $("#buscador").value = e.target.value.trim(); pagina = 1; showView("activos"); renderTable();
});

const PAELLAS = {
  valenciana: { name: "Paella Valenciana con pollo y conejo", price: 17 },
  marisco: { name: "Paella de marisco", price: 20 },
  verduras: { name: "Paella de verduras", price: 17 },
  bogavante: { name: "Paella de bogavante", price: 24 }
};

const STRIPE_WORKER_URL = "https://oasis-daypass-stripe-live.infooasisresort.workers.dev";

const CAPACITY_GUARD = "or-reservas-read-v1";
const REQUEST_TIMEOUT_MS = 10000;
const AVAILABILITY_MAX_AGE_MS = 30000;
const AVAILABILITY_CLOCK_SKEW_MS = 5000;
const availability = { status: "unknown", selection: null, checkedAt: null, timer: null, version: 0, controller: null };
const booking = { busy: false, attempt: null, frozenControls: [], verifyingReturn: false };

const state = {
  adults: 2,
  children: 0,
  tent: "none",
  gazebo: false,
  paellaType: "none",
  paellaServings: 4,
  entry: "10:00"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function people() {
  return state.adults + state.children;
}

function capacitySelection() {
  return { date: $("#date").value, adults: state.adults, children: state.children };
}

function selectionKey(selection) {
  return JSON.stringify(selection);
}

function validSelection(selection) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selection.date)) return false;
  const parsed = new Date(`${selection.date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === selection.date
    && selection.date >= $("#date").min
    && Number.isSafeInteger(selection.adults) && selection.adults >= 0
    && Number.isSafeInteger(selection.children) && selection.children >= 0
    && Number.isSafeInteger(selection.adults + selection.children) && selection.adults + selection.children > 0;
}

function validIso(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  return new Date(`${parts[1]}T00:00:00Z`).toISOString().slice(0, 10) === parts[1]
    && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60
    && (!parts[5] || Number(parts[5]) < 24 && Number(parts[6]) < 60);
}

function bookingSignature(payload, paymentMethod) {
  return JSON.stringify({ payload, paymentMethod, firstName: $("#first-name").value.trim(), lastName: $("#last-name").value.trim() });
}

function freshAvailability() {
  return validIso(availability.checkedAt)
    && Date.now() - Date.parse(availability.checkedAt) <= AVAILABILITY_MAX_AGE_MS
    && Date.parse(availability.checkedAt) - Date.now() <= AVAILABILITY_CLOCK_SKEW_MS;
}

function updateBookingButtons() {
  const ready = availability.status === "available" && availability.selection === selectionKey(capacitySelection()) && freshAvailability();
  $("#card-payment-button").disabled = $("#manual-transfer-button").disabled = booking.busy || booking.verifyingReturn || !ready;
}

function availabilityMessage(status, message) {
  availability.status = status;
  $("#availability-status").textContent = message;
  $("#availability-status").dataset.state = status;
  $("#availability-retry").classList.toggle("hidden", !["error", "blocked", "stale"].includes(status));
  $("#availability-retry").disabled = booking.busy || status === "checking";
  if (status !== "available") hideManualConfirmation();
  updateBookingButtons();
}

function hideManualConfirmation() {
  $("#confirmation").classList.add("hidden");
  $("#whatsapp-link").href = "#";
  for (const id of ["#reference-output", "#payment-reference", "#payment-total"]) $(id).textContent = "";
}

function invalidateBooking() {
  if (booking.busy) return;
  if (booking.attempt && booking.attempt.signature !== bookingSignature(paymentPayload(), booking.attempt.paymentMethod)) {
    booking.attempt = null;
    hideManualConfirmation();
  }
  updateBookingButtons();
}

function showFormError(message) {
  $("#form-error").textContent = message;
  $("#form-error").classList.remove("hidden");
}

async function fetchJson(path, options = {}, controller = new AbortController()) {
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${STRIPE_WORKER_URL}${path}`, { ...options, signal: controller.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) {
          const failure = new Error("No se pudo verificar la disponibilidad.");
          failure.status = response.status;
          throw failure;
        }
        return result;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("La comprobación ha tardado demasiado. Vuelve a intentarlo."));
        }, REQUEST_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAvailability() {
  if (booking.busy) return;
  const version = ++availability.version;
  clearTimeout(availability.timer);
  availability.checkedAt = null;
  if (availability.controller) availability.controller.abort();
  const controller = new AbortController();
  availability.controller = controller;
  const selection = capacitySelection();
  const key = selectionKey(selection);
  availability.selection = key;
  if (!validSelection(selection)) {
    availabilityMessage("unknown", "Selecciona una fecha y al menos una persona para comprobar las plazas.");
    return;
  }
  availabilityMessage("checking", "Comprobando las plazas disponibles…");
  try {
    const parameters = new URLSearchParams(selection);
    const result = await fetchJson(`/availability?${parameters}`, {}, controller);
    if (version !== availability.version || key !== selectionKey(capacitySelection())) return;
    if (!result || result.capacityGuard !== CAPACITY_GUARD
      || result.date !== selection.date || result.adults !== selection.adults || result.children !== selection.children
      || !Number.isSafeInteger(result.remaining) || result.remaining < 0 || !validIso(result.checkedAt)
      || Date.now() - Date.parse(result.checkedAt) > AVAILABILITY_MAX_AGE_MS
      || Date.parse(result.checkedAt) - Date.now() > AVAILABILITY_CLOCK_SKEW_MS
      || typeof result.available !== "boolean" || result.available !== (result.remaining >= selection.adults + selection.children)) {
      throw new Error("La disponibilidad no se ha podido verificar.");
    }
    availability.checkedAt = result.checkedAt;
    availability.timer = setTimeout(() => {
      if (version !== availability.version || key !== selectionKey(capacitySelection())) return;
      availabilityMessage("stale", "La comprobación de plazas ha caducado. Vuelve a comprobarlas antes de preparar un nuevo pedido.");
    }, Math.max(0, Date.parse(result.checkedAt) + AVAILABILITY_MAX_AGE_MS - Date.now() + 1));
    availabilityMessage(result.available ? "available" : "blocked", result.available
      ? "Hay plazas para vuestro grupo. Las comprobaremos de nuevo al preparar el pedido."
      : `Máximo disponible para esta fecha: ${result.remaining} persona${result.remaining === 1 ? "" : "s"}. ${result.remaining === 0
        ? "No quedan plazas Day Pass para esta fecha. Elige otra fecha."
        : "No quedan plazas suficientes para vuestro grupo. Cambia la fecha o el número de personas."}`);
  } catch {
    if (version !== availability.version || key !== selectionKey(capacitySelection())) return;
    availabilityMessage("error", "No podemos comprobar las plazas ahora. El pedido y el pago están bloqueados. Vuelve a intentarlo.");
  }
}

function freezeBooking(busy) {
  booking.busy = busy;
  if (busy) {
    booking.frozenControls = $$("#booking-form input, #booking-form textarea, #booking-form button")
      .map((control) => ({ control, disabled: control.disabled }));
    booking.frozenControls.forEach(({ control }) => { control.disabled = true; });
  } else {
    booking.frozenControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
    booking.frozenControls = [];
  }
  $("#booking-form").setAttribute("aria-busy", String(busy));
  $("#availability-retry").disabled = busy;
  updateBookingButtons();
}

function totals() {
  const selected = PAELLAS[state.paellaType];
  const access = state.adults * 39 + state.children * 29;
  const tent = state.tent === "none" ? 0 : 30;
  const gazebo = state.gazebo ? people() * 9 : 0;
  const paella = selected ? selected.price * state.paellaServings : 0;
  return { access, tent, gazebo, paella, total: access + tent + gazebo + paella };
}

function row(label, value, accent = false) {
  return `<div class="summary-row${accent ? " accent" : ""}"><span>${label}</span><b>${value}</b></div>`;
}

function render() {
  const selected = PAELLAS[state.paellaType];
  const amount = totals();
  $("#adults-output").textContent = state.adults;
  $("#children-output").textContent = state.children;
  $("#paella-servings-output").textContent = state.paellaServings;
  $("#gazebo-price").textContent = `+${people() * 9} €`;
  $("#gazebo-option").classList.toggle("selected", state.gazebo);
  $("#paella-builder").classList.toggle("selected", Boolean(selected));
  $("#paella-minimum-note").textContent = people() < 4
    ? `Aunque sois ${people()}, se aplica el mínimo de 4 raciones.`
    : "Una ración por persona como mínimo.";

  let rows = row(`${state.adults} adulto${state.adults === 1 ? "" : "s"}`, `${state.adults * 39} €`);
  if (state.children > 0) rows += row(`${state.children} niño${state.children === 1 ? "" : "s"}`, `${state.children * 29} €`);
  if (state.tent !== "none") rows += row(`Carpa ${state.tent.slice(1)}`, "30 €", true);
  if (state.gazebo) rows += row("Mesa en cenador", `${amount.gazebo} €`);
  if (selected) rows += row(`${selected.name} · ${state.paellaServings} raciones`, `${amount.paella} €`, true);
  $("#summary-rows").innerHTML = rows;
  $("#total-output").textContent = `${amount.total} €`;
  invalidateBooking();
}

function normalizePaellaServings() {
  if (state.paellaType !== "none") state.paellaServings = Math.max(4, people());
}

function changeCounter(name, step) {
  if (booking.busy) return;
  const minimum = name === "paellaServings" ? 4 : 0;
  state[name] = Math.max(minimum, state[name] + step);
  if (name !== "paellaServings") normalizePaellaServings();
  render();
  if (name !== "paellaServings") checkAvailability();
}

$$("[data-counter] button").forEach((button) => {
  button.addEventListener("click", () => changeCounter(button.parentElement.dataset.counter, Number(button.dataset.step)));
});

$$("[data-entry]").forEach((button) => {
  button.addEventListener("click", () => {
    if (booking.busy) return;
    state.entry = button.dataset.entry;
    invalidateBooking();
    $$("[data-entry]").forEach((item) => item.classList.toggle("selected", item === button));
    $("#late-time-wrap").classList.toggle("hidden", state.entry !== "Después de las 12:00");
  });
});

$$("[data-tent]").forEach((button) => {
  button.addEventListener("click", () => {
    if (booking.busy) return;
    state.tent = button.dataset.tent;
    $$("[data-tent]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-checked", String(selected));
    });
    render();
  });
});

$("#gazebo").addEventListener("change", (event) => {
  if (booking.busy) return;
  state.gazebo = event.target.checked;
  render();
});

$("#paella-toggle").addEventListener("click", () => {
  if (booking.busy) return;
  const adding = state.paellaType === "none";
  state.paellaType = adding ? "valenciana" : "none";
  normalizePaellaServings();
  $("#paella-details").classList.toggle("hidden", !adding);
  $("#paella-toggle").textContent = adding ? "Quitar" : "Añadir";
  $("#paella-toggle").classList.toggle("active", adding);
  render();
});

$$("[data-paella]").forEach((button) => {
  button.addEventListener("click", () => {
    if (booking.busy) return;
    state.paellaType = button.dataset.paella;
    $$("[data-paella]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-checked", String(selected));
    });
    render();
  });
});

$("#date").min = new Date().toISOString().slice(0, 10);

function showManualTransfer(reference) {
  const lateTime = $("#late-time").value;
  const selected = PAELLAS[state.paellaType];
  const amount = totals();
  const entryTime = state.entry === "Después de las 12:00" ? lateTime : state.entry;
  const firstName = $("#first-name").value.trim();
  const lastName = $("#last-name").value.trim();
  const phone = $("#phone").value.trim();
  const email = $("#email").value.trim();
  const additionalInfo = $("#additional-info").value.trim();

  const whatsappText = [
    "NUEVO PEDIDO DAY PASS — WEB",
    `Referencia: ${reference}`,
    `Nombre: ${firstName}`,
    `Apellidos: ${lastName}`,
    `Teléfono: ${phone}`,
    email ? `Email: ${email}` : null,
    `Fecha: ${$("#date").value}`,
    `Entrada: ${entryTime}${state.entry === "Después de las 12:00" ? " (pendiente de confirmación)" : ""}`,
    `Personas: ${state.adults} adulto${state.adults === 1 ? "" : "s"} y ${state.children} niño${state.children === 1 ? "" : "s"}`,
    `Carpa: ${state.tent === "none" ? "Sin carpa" : state.tent}`,
    `Mesa preparada en cenador: ${state.gazebo ? `Sí — ${people()} × 9 € = ${amount.gazebo} €` : "No"}`,
    selected ? `Paella: ${selected.name} — ${state.paellaServings} raciones × ${selected.price} € = ${amount.paella} €` : "Paella: No",
    additionalInfo ? `Información adicional: ${additionalInfo}` : null,
    `TOTAL: ${amount.total} €`,
    "Estado: pendiente de verificación del pago"
  ].filter(Boolean).join("\n");

  const whatsappUrl = `https://wa.me/34962750461?text=${encodeURIComponent(whatsappText)}`;
  $("#reference-output").textContent = reference;
  $("#payment-reference").textContent = reference;
  $("#payment-total").textContent = `${amount.total} €`;
  $("#whatsapp-link").href = whatsappUrl;
  $("#confirmation").classList.remove("hidden");
  $("#confirmation").scrollIntoView({ behavior: "smooth" });
  window.open(whatsappUrl, "_blank", "noopener,noreferrer");
}

function paymentPayload() {
  const lateTime = $("#late-time").value;
  return {
    date: $("#date").value,
    entryTime: state.entry === "Después de las 12:00" ? lateTime : state.entry,
    entryNeedsConfirmation: state.entry === "Después de las 12:00",
    adults: state.adults,
    children: state.children,
    tent: state.tent,
    gazebo: state.gazebo,
    paellaType: state.paellaType,
    paellaServings: state.paellaType === "none" ? 0 : state.paellaServings,
    customer: {
      name: `${$("#first-name").value.trim()} ${$("#last-name").value.trim()}`.trim(),
      phone: $("#phone").value.trim(),
      email: $("#email").value.trim(),
      dietaryNotes: $("#additional-info").value.trim()
    }
  };
}

async function startCardPayment(event) { return submitBooking(event, "card"); }
async function prepareManualTransfer(event) { return submitBooking(event, "transfer"); }

async function submitBooking(event, paymentMethod) {
  event.preventDefault();
  if (booking.busy || booking.verifyingReturn || !$("#booking-form").reportValidity()) return;
  if (!validSelection(capacitySelection())) { showFormError("Indica una fecha válida y al menos una persona."); return; }
  if (state.entry === "Después de las 12:00" && !$("#late-time").value) {
    showFormError("Indica la hora de llegada que deseas solicitar."); return;
  }
  if (availability.status !== "available" || availability.selection !== selectionKey(capacitySelection()) || !freshAvailability()) {
    showFormError("Comprueba las plazas disponibles antes de preparar el pedido."); return;
  }
  $("#form-error").classList.add("hidden");
  hideManualConfirmation();
  const payload = paymentPayload();
  const signature = bookingSignature(payload, paymentMethod);
  const button = $(paymentMethod === "card" ? "#card-payment-button" : "#manual-transfer-button");
  const originalText = button.textContent;
  freezeBooking(true);
  button.textContent = paymentMethod === "card" ? "Abriendo pago seguro." : "Verificando las plazas.";
  try {
    if (!booking.attempt || booking.attempt.signature !== signature) {
      booking.attempt = { signature, paymentMethod, idempotencyKey: crypto.randomUUID() };
    }
    const attempt = booking.attempt;
    const body = { ...payload, paymentMethod, idempotencyKey: attempt.idempotencyKey };
    if (paymentMethod === "transfer" || !attempt.reference) {
      const reservation = await fetchJson("/reservations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!reservation || reservation.capacityGuard !== CAPACITY_GUARD || typeof reservation.reference !== "string" || !reservation.reference.trim()
        || attempt.reference && attempt.reference !== reservation.reference) {
        throw new Error("No se ha podido verificar el pedido. El pago está bloqueado.");
      }
      attempt.reference = reservation.reference;
    }
    if (signature !== bookingSignature(paymentPayload(), paymentMethod)) throw new Error("La selección ha cambiado.");
    if (paymentMethod === "transfer") {
      if (availability.status !== "available" || !freshAvailability()) throw new Error("Vuelve a comprobar las plazas.");
      showManualTransfer(attempt.reference);
      return;
    }
    const checkout = await fetchJson("/create-checkout-session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, reference: attempt.reference })
    });
    let checkoutUrl;
    try { checkoutUrl = new URL(checkout.url); } catch { /* Invalid URL is blocked below. */ }
    if (!checkout || checkout.capacityGuard !== CAPACITY_GUARD || !checkoutUrl
      || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com"
      || checkoutUrl.username || checkoutUrl.password || checkoutUrl.port
      || signature !== bookingSignature(paymentPayload(), paymentMethod)) throw new Error("No se ha podido verificar el cobro.");
    window.location.assign(checkoutUrl.href);
  } catch (cause) {
    const unavailable = cause && cause.status === 409;
    availabilityMessage(unavailable ? "blocked" : "error", unavailable
      ? "Las plazas han cambiado y no hay plazas suficientes para continuar. Vuelve a comprobarlas."
      : "No podemos verificar el pedido ahora. El pago está bloqueado. Vuelve a comprobar las plazas.");
    showFormError("No se ha abierto el cobro ni preparado una transferencia. Si la conexión falló, conserva los mismos datos al reintentar.");
  } finally {
    button.textContent = originalText;
    freezeBooking(false);
  }
}

async function verifyReturnedPayment() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("payment") === "cancel") {
    showFormError("Has vuelto del pago sin confirmación. Comprueba las plazas antes de reintentarlo."); return;
  }
  if (parameters.get("payment") !== "success") return;
  booking.verifyingReturn = true;
  updateBookingButtons();
  const sessionId = parameters.get("session_id") || "";
  showFormError("Verificando el pago con Stripe.");
  if (!sessionId) { showFormError("No podemos verificar este pago. No repitas el pago; consulta su estado con El Oasis."); return; }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await fetchJson(`/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`);
      if (result && ["expired", "cancelled", "canceled"].includes(result.status)) {
        showFormError("No hay confirmación de este pago. Si has pagado, consulta su estado con El Oasis antes de reintentarlo."); return;
      }
      if (result && result.confirmed === true && typeof result.reference === "string" && result.reference.trim()
        && (result.status === undefined || ["paid", "confirmed", "complete", "completed"].includes(result.status))) {
        $("#paid-reference-output").textContent = result.reference;
        $("#payment-confirmation").classList.remove("hidden");
        $("#form-error").classList.add("hidden");
        booking.verifyingReturn = false;
        booking.attempt = null;
        hideManualConfirmation();
        updateBookingButtons();
        window.history.replaceState({}, "", `${window.location.pathname}#payment-confirmation`);
        $("#payment-confirmation").scrollIntoView({ behavior: "smooth" });
        return;
      }
    } catch { /* Only read-only payment verification is retried. */ }
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  showFormError("La confirmación del pago todavía se está procesando. No repitas el pago. Recarga esta página en unos segundos.");
}

$("#booking-form").addEventListener("submit", startCardPayment);
$("#manual-transfer-button").addEventListener("click", prepareManualTransfer);
function dateChanged() {
  if (booking.busy) return;
  invalidateBooking();
  if (availability.selection !== selectionKey(capacitySelection()) || availability.status === "unknown") return checkAvailability();
}
$("#date").addEventListener("input", dateChanged);
$("#date").addEventListener("change", dateChanged);
for (const id of ["#late-time", "#first-name", "#last-name", "#phone", "#email", "#additional-info"]) {
  $(id).addEventListener("input", invalidateBooking);
  $(id).addEventListener("change", invalidateBooking);
}
$("#availability-retry").addEventListener("click", checkAvailability);
$("#whatsapp-link").addEventListener("click", (event) => {
  const attempt = booking.attempt;
  if (!attempt || attempt.paymentMethod !== "transfer" || attempt.signature !== bookingSignature(paymentPayload(), "transfer")
    || availability.status !== "available" || !freshAvailability()) {
    event.preventDefault(); hideManualConfirmation(); showFormError("Comprueba las plazas antes de preparar la transferencia.");
  }
});
render();
checkAvailability();
verifyReturnedPayment();

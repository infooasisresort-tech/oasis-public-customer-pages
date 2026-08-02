const PAELLAS = {
  valenciana: { name: "Paella Valenciana con pollo y conejo", price: 17 },
  marisco: { name: "Paella de marisco", price: 20 },
  verduras: { name: "Paella de verduras", price: 17 },
  bogavante: { name: "Paella de bogavante", price: 24 }
};

const STRIPE_WORKER_URL = "https://oasis-daypass-stripe-live.infooasisresort.workers.dev";

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
}

function normalizePaellaServings() {
  if (state.paellaType !== "none") state.paellaServings = Math.max(4, people());
}

function changeCounter(name, step) {
  const minimum = name === "paellaServings" ? 4 : 0;
  state[name] = Math.max(minimum, state[name] + step);
  if (name !== "paellaServings") normalizePaellaServings();
  render();
}

function makeReference() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `DP-${date}-${String(random[0] % 10000).padStart(4, "0")}`;
}

$$("[data-counter] button").forEach((button) => {
  button.addEventListener("click", () => changeCounter(button.parentElement.dataset.counter, Number(button.dataset.step)));
});

$$("[data-entry]").forEach((button) => {
  button.addEventListener("click", () => {
    state.entry = button.dataset.entry;
    $$("[data-entry]").forEach((item) => item.classList.toggle("selected", item === button));
    $("#late-time-wrap").classList.toggle("hidden", state.entry !== "Después de las 12:00");
  });
});

$$("[data-tent]").forEach((button) => {
  button.addEventListener("click", () => {
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
  state.gazebo = event.target.checked;
  render();
});

$("#paella-toggle").addEventListener("click", () => {
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

function prepareManualTransfer(event) {
  event.preventDefault();
  if (!$("#booking-form").reportValidity()) return;
  const error = $("#form-error");
  error.classList.add("hidden");

  if (people() < 1) {
    error.textContent = "Indica al menos una persona.";
    error.classList.remove("hidden");
    return;
  }
  const lateTime = $("#late-time").value;
  if (state.entry === "Después de las 12:00" && !lateTime) {
    error.textContent = "Indica la hora de llegada que deseas solicitar.";
    error.classList.remove("hidden");
    return;
  }

  const reference = makeReference();
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

async function startCardPayment(event) {
  event.preventDefault();
  const error = $("#form-error");
  const button = $("#card-payment-button");
  error.classList.add("hidden");

  if (people() < 1) {
    error.textContent = "Indica al menos una persona.";
    error.classList.remove("hidden");
    return;
  }
  if (state.entry === "Después de las 12:00" && !$("#late-time").value) {
    error.textContent = "Indica la hora de llegada que deseas solicitar.";
    error.classList.remove("hidden");
    return;
  }

  button.disabled = true;
  button.textContent = "Abriendo pago seguro…";
  try {
    const payload = paymentPayload();
    const reservationResponse = await fetch(`${STRIPE_WORKER_URL}/reservations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const reservation = await reservationResponse.json();
    if (!reservationResponse.ok || !reservation.reference) {
      throw new Error(reservation.error || "No se pudo registrar la solicitud.");
    }

    const checkoutResponse = await fetch(`${STRIPE_WORKER_URL}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, reference: reservation.reference })
    });
    const checkout = await checkoutResponse.json();
    if (!checkoutResponse.ok || !checkout.url) {
      throw new Error(checkout.error || "No se pudo abrir Stripe Checkout.");
    }
    window.location.assign(checkout.url);
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "No se pudo abrir el pago seguro.";
    error.classList.remove("hidden");
    button.disabled = false;
    button.textContent = "Pagar con tarjeta";
  }
}

async function verifyReturnedPayment() {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("payment") !== "success") return;
  const sessionId = parameters.get("session_id") || "";
  const error = $("#form-error");
  error.textContent = "Verificando el pago con Stripe…";
  error.classList.remove("hidden");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(`${STRIPE_WORKER_URL}/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`);
      const result = await response.json();
      if (response.ok && result.confirmed) {
        $("#paid-reference-output").textContent = result.reference;
        $("#payment-confirmation").classList.remove("hidden");
        error.classList.add("hidden");
        window.history.replaceState({}, "", `${window.location.pathname}#payment-confirmation`);
        $("#payment-confirmation").scrollIntoView({ behavior: "smooth" });
        return;
      }
    } catch {
      // A brief webhook delay or transient network error is retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  error.textContent = "Stripe ha devuelto el pago, pero la confirmación segura todavía está procesándose. Recarga esta página en unos segundos.";
}

$("#booking-form").addEventListener("submit", startCardPayment);
$("#manual-transfer-button").addEventListener("click", prepareManualTransfer);

render();
verifyReturnedPayment();

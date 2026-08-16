// ============================================================
// 撮影地帳 - 地図・フィルター・チケット詳細の制御
// ============================================================

const CATEGORY_LABEL = { rail: "鉄道", bus: "バス", flower: "花・風景" };
const CATEGORY_ICON  = { rail: "🚃", bus: "🚌", flower: "🌸" };

let map;
let markers = {};       // id -> L.Marker
let currentFilter = "all";
let currentLocation = null;   // { lat, lng }
let currentMarker = null;     // L.Marker for user's position
let sortByDistance = false;

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  renderMarkers();
  renderList();
  bindFilterBar();
  bindDrawer();
  bindTicketOverlay();
  bindLocate();
});

function initMap(){
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true
  }).setView([43.2, 142.6], 7);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
}

function makeIcon(category, selected){
  return L.divIcon({
    className: "",
    html: `
      <div class="pin pin-${category}${selected ? " is-selected" : ""}">
        <div class="pin-hole"></div>
        <div class="pin-tag">${CATEGORY_ICON[category] || "📍"}</div>
        <div class="pin-point"></div>
      </div>`,
    iconSize: [40, 52],
    iconAnchor: [20, 52],
    popupAnchor: [0, -48]
  });
}

function renderMarkers(){
  SPOT_DATA.forEach(spot => {
    const marker = L.marker([spot.lat, spot.lng], { icon: makeIcon(spot.category, false) });
    marker.on("click", () => openTicket(spot.id));
    markers[spot.id] = marker;
  });
  applyFilter(currentFilter);
}

function applyFilter(filter){
  currentFilter = filter;
  Object.entries(markers).forEach(([id, marker]) => {
    const spot = SPOT_DATA.find(s => s.id === id);
    const visible = filter === "all" || spot.category === filter;
    if (visible && !map.hasLayer(marker)) marker.addTo(map);
    if (!visible && map.hasLayer(marker)) map.removeLayer(marker);
  });
  renderList();
}

function bindFilterBar(){
  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      applyFilter(chip.dataset.filter);
    });
  });
}

function visibleSpots(){
  let spots = SPOT_DATA.filter(s => currentFilter === "all" || s.category === currentFilter);
  if (sortByDistance && currentLocation){
    spots = spots
      .map(s => ({ ...s, _dist: distanceKm(currentLocation, { lat: s.lat, lng: s.lng }) }))
      .sort((a, b) => a._dist - b._dist);
  }
  return spots;
}

function renderList(){
  const list = document.getElementById("spotList");
  const spots = visibleSpots();
  document.getElementById("spotCount").textContent = spots.length;

  if (spots.length === 0){
    list.innerHTML = `<div class="spot-empty">このカテゴリのスポットはまだありません。<br>data.js に追加してみましょう。</div>`;
    return;
  }

  list.innerHTML = spots.map(spot => `
    <button class="spot-card" data-id="${spot.id}">
      <span class="spot-card-dot ${spot.category}"></span>
      <span class="spot-card-text">
        <p class="spot-card-name">${escapeHtml(spot.name)}</p>
        <p class="spot-card-line">${escapeHtml(spot.line || CATEGORY_LABEL[spot.category])}</p>
      </span>
      ${typeof spot._dist === "number" ? `<span class="spot-card-distance">${formatDistance(spot._dist)}</span>` : ""}
    </button>
  `).join("");

  list.querySelectorAll(".spot-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      const spot = SPOT_DATA.find(s => s.id === id);
      map.setView([spot.lat, spot.lng], 11, { animate: true });
      openTicket(id);
    });
  });
}

// ---------------- Distance helpers ----------------
function distanceKm(a, b){
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function toRad(deg){ return deg * Math.PI / 180; }
function formatDistance(km){
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

// ---------------- Geolocation (opt-in, one-shot) ----------------
function bindLocate(){
  const btn = document.getElementById("locateBtn");
  const sortToggle = document.getElementById("sortToggle");

  btn.addEventListener("click", () => requestLocation({ recenter: true }));

  sortToggle.addEventListener("click", () => {
    if (!currentLocation){
      requestLocation({ recenter: false, thenSort: true });
      return;
    }
    sortByDistance = !sortByDistance;
    sortToggle.setAttribute("aria-pressed", String(sortByDistance));
    renderList();
  });
}

function requestLocation({ recenter, thenSort }){
  if (!navigator.geolocation){
    setLocateStatus("この端末では現在地を取得できません");
    return;
  }

  const btn = document.getElementById("locateBtn");
  btn.classList.add("is-loading");
  setLocateStatus("現在地を取得中…");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove("is-loading");
      btn.classList.add("is-active");
      currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      placeCurrentMarker();

      if (recenter) map.setView([currentLocation.lat, currentLocation.lng], 10, { animate: true });

      if (thenSort){
        sortByDistance = true;
        document.getElementById("sortToggle").setAttribute("aria-pressed", "true");
      }
      renderList();
      setLocateStatus("");
    },
    (err) => {
      btn.classList.remove("is-loading");
      const message = err.code === err.PERMISSION_DENIED
        ? "位置情報の利用が許可されていません"
        : "現在地を取得できませんでした";
      setLocateStatus(message);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

function placeCurrentMarker(){
  if (!currentLocation) return;
  const icon = L.divIcon({
    className: "",
    html: `<div class="current-dot"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (currentMarker){
    currentMarker.setLatLng([currentLocation.lat, currentLocation.lng]);
  } else {
    currentMarker = L.marker([currentLocation.lat, currentLocation.lng], { icon, zIndexOffset: 1000 }).addTo(map);
  }
}

function setLocateStatus(text){
  document.getElementById("locateStatus").textContent = text;
}

function bindDrawer(){
  const drawer = document.getElementById("spotDrawer");
  const handle = document.getElementById("drawerHandle");
  handle.addEventListener("click", () => drawer.classList.toggle("is-open"));
}

// ---------------- Ticket detail overlay ----------------
function openTicket(id){
  const spot = SPOT_DATA.find(s => s.id === id);
  if (!spot) return;

  Object.entries(markers).forEach(([mid, marker]) => {
    const s = SPOT_DATA.find(sp => sp.id === mid);
    marker.setIcon(makeIcon(s.category, mid === id));
  });

  const photoEl = document.getElementById("ticketPhoto");
  if (spot.photo){
    photoEl.style.backgroundImage = `url("${spot.photo}")`;
    photoEl.textContent = "";
  } else {
    photoEl.style.backgroundImage = "none";
    photoEl.textContent = CATEGORY_ICON[spot.category] || "📍";
  }

  const catEl = document.getElementById("ticketCategory");
  catEl.textContent = CATEGORY_LABEL[spot.category] || "";
  catEl.className = `ticket-category ${spot.category}`;

  document.getElementById("ticketName").textContent = spot.name;
  document.getElementById("ticketLine").textContent = spot.line || "";
  document.getElementById("ticketMemo").textContent = spot.memo || "";
  document.getElementById("ticketSeason").textContent = spot.season ? `おすすめ時期：${spot.season}` : "";

  document.getElementById("ticketOverlay").classList.add("is-open");
}

function closeTicket(){
  document.getElementById("ticketOverlay").classList.remove("is-open");
}

function bindTicketOverlay(){
  const overlay = document.getElementById("ticketOverlay");
  document.getElementById("ticketClose").addEventListener("click", closeTicket);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTicket();
  });
}

function escapeHtml(str){
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

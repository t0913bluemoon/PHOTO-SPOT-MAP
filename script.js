// ============================================================
// 撮影地帳 - 地図・フィルター・記録・スポット詳細の制御
// ============================================================

const CATEGORY_LABEL = { rail: "鉄道", bus: "バス", flower: "花・風景" };
const CATEGORY_ICON  = { rail: "🚃", bus: "🚌", flower: "🌸" };

const STORAGE_CUSTOM  = "photospot_custom_v1";
const STORAGE_VISITED = "photospot_visited_v1";

let map;
let markers = {};       // id -> L.Marker
let currentFilter = "all";
let currentLocation = null;   // { lat, lng }
let currentMarker = null;     // L.Marker for user's position
let sortByDistance = false;

let customSpots = [];   // spots added via the "記録" flow, persisted to localStorage
let visited = {};       // id -> true

let pickingLocation = false;  // true while waiting for a map tap to set a new spot's position
let pendingLocation = null;   // { lat, lng } chosen for the spot currently being added
let pendingCategory = null;
let pendingPhotoDataUrl = null; // resized photo, as a data URL, chosen for the spot currently being added
let editingSpotId = null;     // 編集中の記録のid（新規追加時はnull）

document.addEventListener("DOMContentLoaded", () => {
  // UIのボタン類は、地図やデータの読み込みが失敗しても必ず反応するよう先に登録する
  bindFilterBar();
  bindDrawer();
  bindTicketOverlay();
  bindLocate();
  bindAddSpot();

  loadCustomSpots();
  loadVisited();

  try{
    initMap();
    renderMarkers();
    renderList();
  }catch(err){
    console.error("撮影地帳: 地図の初期化中にエラーが発生しました。", err);
  }
});

// ---------------- Storage ----------------
function loadCustomSpots(){
  try{
    const raw = localStorage.getItem(STORAGE_CUSTOM);
    customSpots = raw ? JSON.parse(raw) : [];
  }catch(e){ customSpots = []; }
}
function saveCustomSpots(){
  try{ localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(customSpots)); }
  catch(e){ /* storage unavailable, fail silently */ }
}
function loadVisited(){
  try{
    const raw = localStorage.getItem(STORAGE_VISITED);
    visited = raw ? JSON.parse(raw) : {};
  }catch(e){ visited = {}; }
}
function saveVisited(){
  try{ localStorage.setItem(STORAGE_VISITED, JSON.stringify(visited)); }
  catch(e){ /* storage unavailable, fail silently */ }
}

function getAllSpots(){
  return (typeof SPOT_DATA !== "undefined" ? SPOT_DATA : []).concat(customSpots);
}
function findSpot(id){
  return getAllSpots().find(s => s.id === id);
}

// ---------------- Map ----------------
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

  map.on("click", (e) => {
    if (!pickingLocation) return;
    pendingLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
    exitPickingMode();
    openAddSheet({ keepPending: true });
  });
}

function makeIcon(category, selected, isVisited){
  return L.divIcon({
    className: "",
    html: `
      <div class="pin pin-${category}${selected ? " is-selected" : ""}">
        <div class="pin-body"></div>
        <div class="pin-icon">${CATEGORY_ICON[category] || "📍"}</div>
        ${isVisited ? '<div class="pin-visited">✓</div>' : ""}
      </div>`,
    iconSize: [34, 42],
    iconAnchor: [17, 40],
    popupAnchor: [0, -38]
  });
}

function renderMarkers(){
  getAllSpots().forEach(spot => addMarkerForSpot(spot));
  applyFilter(currentFilter);
}

function addMarkerForSpot(spot){
  if (markers[spot.id]) return;
  try{
    const marker = L.marker([spot.lat, spot.lng], { icon: makeIcon(spot.category, false, !!visited[spot.id]) });
    marker.on("click", () => openTicket(spot.id));
    marker.addTo(map);
    markers[spot.id] = marker;
  }catch(err){
    // 緯度・経度が不正など、1件のスポットが壊れていても他のスポットの表示は止めない
    console.warn(`撮影地帳: スポット「${spot && spot.name}」(id: ${spot && spot.id}) の表示に失敗しました。`, err);
  }
}

function applyFilter(filter){
  currentFilter = filter;
  Object.entries(markers).forEach(([id, marker]) => {
    const spot = findSpot(id);
    const visibleSpot = filter === "all" || (spot && spot.category === filter);
    if (visibleSpot && !map.hasLayer(marker)) marker.addTo(map);
    if (!visibleSpot && map.hasLayer(marker)) map.removeLayer(marker);
  });
  renderList();
}

function bindFilterBar(){
  document.querySelectorAll("#filterTabs .tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#filterTabs .tab").forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      applyFilter(tab.dataset.filter);
    });
  });
}

function visibleSpots(){
  let spots = getAllSpots().filter(s => currentFilter === "all" || s.category === currentFilter);
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
  document.getElementById("totalCount").textContent = getAllSpots().length;
  document.getElementById("visitedCount").textContent = Object.keys(visited).filter(id => visited[id] && findSpot(id)).length;

  if (spots.length === 0){
    list.innerHTML = `<div class="spot-empty">このカテゴリのスポットはまだありません。<br>右下の「＋記録」から追加できます。</div>`;
    return;
  }

  list.innerHTML = spots.map(spot => `
    <button class="spot-card" data-id="${spot.id}">
      <span class="spot-card-icon ${spot.category}${spot.photo ? " has-photo" : ""}">
        ${spot.photo
          ? `<span class="spot-card-cat-badge ${spot.category}">${CATEGORY_ICON[spot.category] || "📍"}</span>`
          : (CATEGORY_ICON[spot.category] || "📍")}
        ${visited[spot.id] ? '<span class="spot-card-visited">✓</span>' : ""}
      </span>
      <span class="spot-card-text">
        <p class="spot-card-name">${escapeHtml(spot.name)}</p>
        <p class="spot-card-line">${escapeHtml(spot.line || CATEGORY_LABEL[spot.category])}</p>
      </span>
      ${typeof spot._dist === "number" ? `<span class="spot-card-distance">${formatDistance(spot._dist)}</span>` : ""}
    </button>
  `).join("");

  // 写真URLはHTML文字列に直接埋め込まず、DOM経由でbackground-imageに設定する
  // （URLに " や ' が含まれていてもマークアップが壊れないようにするため）
  const cardEls = list.querySelectorAll(".spot-card");
  cardEls.forEach((card, i) => {
    const spot = spots[i];
    if (spot.photo){
      const iconEl = card.querySelector(".spot-card-icon");
      if (iconEl) iconEl.style.backgroundImage = `url("${spot.photo}")`;
    }
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      const s = findSpot(id);
      map.setView([s.lat, s.lng], 11, { animate: true });
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

function requestLocation({ recenter, thenSort, onDone, onError }){
  if (!navigator.geolocation){
    setLocateStatus("この端末では現在地を取得できません");
    if (onError) onError();
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
      if (onDone) onDone(currentLocation);
    },
    (err) => {
      btn.classList.remove("is-loading");
      const message = err.code === err.PERMISSION_DENIED
        ? "位置情報の利用が許可されていません"
        : "現在地を取得できませんでした";
      setLocateStatus(message);
      if (onError) onError();
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

// ---------------- Spot detail sheet ----------------
function openTicket(id){
  const spot = findSpot(id);
  if (!spot) return;

  const isVisited = !!visited[spot.id];

  Object.entries(markers).forEach(([mid, marker]) => {
    const s = findSpot(mid);
    if (!s) return;
    marker.setIcon(makeIcon(s.category, mid === id, !!visited[mid]));
  });

  const photoEl = document.getElementById("ticketPhoto");
  const photoIconEl = document.getElementById("ticketPhotoIcon");
  if (spot.photo){
    photoEl.style.backgroundImage = `url("${spot.photo}")`;
    photoIconEl.textContent = "";
  } else {
    photoEl.style.backgroundImage = "none";
    photoIconEl.textContent = CATEGORY_ICON[spot.category] || "📍";
  }
  photoEl.classList.toggle("is-visited", isVisited);

  const catEl = document.getElementById("ticketCategory");
  catEl.textContent = CATEGORY_LABEL[spot.category] || "";
  catEl.className = `tag ${spot.category}`;

  document.getElementById("ticketName").textContent = spot.name;
  document.getElementById("ticketLine").textContent = spot.line || "";
  document.getElementById("ticketMemo").textContent = spot.memo || "";
  document.getElementById("ticketSeason").textContent = spot.season ? `おすすめ時期：${spot.season}` : "";

  const toggle = document.getElementById("visitedToggle");
  toggle.setAttribute("aria-pressed", String(isVisited));
  document.getElementById("visitedToggleLabel").textContent = isVisited ? "撮影済み" : "撮影済みにする";
  toggle.onclick = () => toggleVisited(spot.id);

  const actionsWrap = document.getElementById("ticketActions");
  const editBtn = document.getElementById("ticketEdit");
  const deleteBtn = document.getElementById("ticketDelete");
  const isCustom = spot.id.startsWith("custom-");
  actionsWrap.hidden = !isCustom;
  editBtn.onclick = isCustom ? () => openEditSheet(spot.id) : null;
  deleteBtn.onclick = isCustom ? () => deleteCustomSpot(spot.id) : null;

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

function toggleVisited(id){
  if (visited[id]) delete visited[id];
  else visited[id] = true;
  saveVisited();

  const spot = findSpot(id);
  const marker = markers[id];
  if (marker && spot) marker.setIcon(makeIcon(spot.category, true, !!visited[id]));

  const isVisited = !!visited[id];
  const toggle = document.getElementById("visitedToggle");
  toggle.setAttribute("aria-pressed", String(isVisited));
  document.getElementById("visitedToggleLabel").textContent = isVisited ? "撮影済み" : "撮影済みにする";
  document.getElementById("ticketPhoto").classList.toggle("is-visited", isVisited);

  renderList();
}

function deleteCustomSpot(id){
  if (!confirm("この記録を削除しますか？")) return;

  customSpots = customSpots.filter(s => s.id !== id);
  saveCustomSpots();
  delete visited[id];
  saveVisited();

  if (markers[id]){
    map.removeLayer(markers[id]);
    delete markers[id];
  }

  closeTicket();
  renderList();
}

// ---------------- Add-spot flow ----------------
function bindAddSpot(){
  const overlay = document.getElementById("addOverlay");
  const recordBtn = document.getElementById("recordBtn");
  const closeBtn = document.getElementById("addClose");
  const useLocationBtn = document.getElementById("addUseLocation");
  const pickOnMapBtn = document.getElementById("addPickOnMap");
  const nameInput = document.getElementById("addName");
  const chips = document.querySelectorAll("#addCategoryChips .tab");
  const saveBtn = document.getElementById("addSave");

  const photoInput = document.getElementById("addPhoto");
  const photoTrigger = document.getElementById("addPhotoTrigger");
  const photoPreview = document.getElementById("addPhotoPreview");
  const photoPreviewImg = document.getElementById("addPhotoPreviewImg");
  const photoRemoveBtn = document.getElementById("addPhotoRemove");

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    try{
      pendingPhotoDataUrl = await resizeImageFile(file);
      photoPreviewImg.src = pendingPhotoDataUrl;
      photoPreview.hidden = false;
      photoTrigger.hidden = true;
    }catch(err){
      console.warn("撮影地帳: 写真の読み込みに失敗しました。", err);
      alert("写真を読み込めませんでした。別の写真でお試しください。");
      photoInput.value = "";
    }
  });

  photoRemoveBtn.addEventListener("click", () => {
    pendingPhotoDataUrl = null;
    photoInput.value = "";
    photoPreview.hidden = true;
    photoTrigger.hidden = false;
  });

  recordBtn.addEventListener("click", () => openAddSheet());
  closeBtn.addEventListener("click", () => closeAddSheet());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeAddSheet(); });

  useLocationBtn.addEventListener("click", () => {
    if (currentLocation){
      pendingLocation = { ...currentLocation };
      updateAddLocationUI();
      return;
    }
    requestLocation({
      recenter: false,
      onDone: (loc) => { pendingLocation = { ...loc }; updateAddLocationUI(); }
    });
  });

  pickOnMapBtn.addEventListener("click", () => {
    closeAddSheet({ keepPending: true });
    enterPickingMode();
  });

  chips.forEach(chip => {
    chip.addEventListener("click", () => {
      pendingCategory = chip.dataset.category;
      chips.forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      updateSaveEnabled();
    });
  });

  nameInput.addEventListener("input", updateSaveEnabled);

  saveBtn.addEventListener("click", () => {
    if (!pendingLocation || !pendingCategory || !nameInput.value.trim()) return;

    const details = {
      name: nameInput.value.trim(),
      category: pendingCategory,
      lat: pendingLocation.lat,
      lng: pendingLocation.lng,
      line: document.getElementById("addLine").value.trim(),
      memo: document.getElementById("addMemo").value.trim(),
      season: document.getElementById("addSeason").value.trim(),
      photo: pendingPhotoDataUrl || ""
    };

    if (editingSpotId){
      const idx = customSpots.findIndex(s => s.id === editingSpotId);
      if (idx === -1) return;
      customSpots[idx] = { ...customSpots[idx], ...details };
      saveCustomSpots();

      const spot = customSpots[idx];
      if (markers[spot.id]){
        markers[spot.id].setLatLng([spot.lat, spot.lng]);
        markers[spot.id].setIcon(makeIcon(spot.category, false, !!visited[spot.id]));
      }
      applyFilter(currentFilter);
      closeAddSheet();
      map.setView([spot.lat, spot.lng], 12, { animate: true });
      openTicket(spot.id);
      return;
    }

    const spot = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ...details
    };

    customSpots.push(spot);
    saveCustomSpots();
    addMarkerForSpot(spot);
    applyFilter(currentFilter);
    closeAddSheet();
    map.setView([spot.lat, spot.lng], 12, { animate: true });
    openTicket(spot.id);
  });
}

function openAddSheet({ keepPending } = {}){
  if (!keepPending){
    pendingLocation = null;
    pendingCategory = null;
    resetAddForm();
  }
  updateAddLocationUI();
  document.getElementById("addOverlay").classList.add("is-open");
}

function closeAddSheet({ keepPending } = {}){
  document.getElementById("addOverlay").classList.remove("is-open");
  if (!keepPending){
    pendingLocation = null;
    pendingCategory = null;
    resetAddForm();
  }
}

function resetAddForm(){
  document.getElementById("addName").value = "";
  document.getElementById("addLine").value = "";
  document.getElementById("addMemo").value = "";
  document.getElementById("addSeason").value = "";
  document.getElementById("addPhoto").value = "";
  document.getElementById("addPhotoPreview").hidden = true;
  document.getElementById("addPhotoTrigger").hidden = false;
  pendingPhotoDataUrl = null;
  document.querySelectorAll("#addCategoryChips .tab").forEach(c => c.classList.remove("is-active"));
  document.getElementById("addStepDetails").hidden = true;
  editingSpotId = null;
  document.getElementById("addSheetTitle").textContent = "スポットを記録";
  document.getElementById("addSave").textContent = "記録する";
  updateSaveEnabled();
}

// 既存の記録を編集モードで開く
function openEditSheet(id){
  const spot = findSpot(id);
  if (!spot) return;

  editingSpotId = id;
  pendingLocation = { lat: spot.lat, lng: spot.lng };
  pendingCategory = spot.category;
  pendingPhotoDataUrl = spot.photo || null;

  document.getElementById("addName").value = spot.name || "";
  document.getElementById("addLine").value = spot.line || "";
  document.getElementById("addMemo").value = spot.memo || "";
  document.getElementById("addSeason").value = spot.season || "";

  document.querySelectorAll("#addCategoryChips .tab").forEach(c => {
    c.classList.toggle("is-active", c.dataset.category === spot.category);
  });

  const photoPreview = document.getElementById("addPhotoPreview");
  const photoTrigger = document.getElementById("addPhotoTrigger");
  if (spot.photo){
    document.getElementById("addPhotoPreviewImg").src = spot.photo;
    photoPreview.hidden = false;
    photoTrigger.hidden = true;
  } else {
    photoPreview.hidden = true;
    photoTrigger.hidden = false;
  }

  document.getElementById("addSheetTitle").textContent = "記録を編集";
  document.getElementById("addSave").textContent = "更新する";
  updateAddLocationUI();

  closeTicket();
  document.getElementById("addOverlay").classList.add("is-open");
}

function updateAddLocationUI(){
  const valueEl = document.getElementById("addLocationValue");
  const detailsStep = document.getElementById("addStepDetails");
  if (pendingLocation){
    valueEl.textContent = `緯度 ${pendingLocation.lat.toFixed(5)} / 経度 ${pendingLocation.lng.toFixed(5)}`;
    detailsStep.hidden = false;
  } else {
    valueEl.textContent = "未選択";
    detailsStep.hidden = true;
  }
  updateSaveEnabled();
}

function updateSaveEnabled(){
  const nameFilled = document.getElementById("addName").value.trim().length > 0;
  document.getElementById("addSave").disabled = !(pendingLocation && pendingCategory && nameFilled);
}

function enterPickingMode(){
  pickingLocation = true;
  document.getElementById("mapBanner").hidden = false;
  document.getElementById("recordBtn").classList.add("is-picking");
}
function exitPickingMode(){
  pickingLocation = false;
  document.getElementById("mapBanner").hidden = true;
  document.getElementById("recordBtn").classList.remove("is-picking");
}

// スマホの写真は容量が大きいため、localStorageに保存できるサイズまで
// 縮小・圧縮してからdata URLとして扱う
function resizeImageFile(file, maxDim = 960, quality = 0.72){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim){
          if (width > height){ height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(str){
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

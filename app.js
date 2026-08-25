// ============================================================
// APP.JS - Logic tiếp đón, in phiếu, danh sách bàn giao V20
// ============================================================

const sb = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

// ============================================================
// ĐĂNG NHẬP (1 tài khoản chung cho cả trạm, dùng Supabase Auth)
// ============================================================
const loginScreenEl = document.getElementById("login-screen");
const appShellEl = document.getElementById("app-shell");
const loginFormEl = document.getElementById("login-form");
const loginErrorEl = document.getElementById("login-error");
const loginSubmitEl = document.getElementById("login-submit");
const loginTramNameEl = document.getElementById("login-tram-name");

if (loginTramNameEl && window.APP_CONFIG.TEN_TRAM) {
  loginTramNameEl.textContent = window.APP_CONFIG.TEN_TRAM;
}

function showApp() {
  if (loginScreenEl) loginScreenEl.style.display = "none";
  if (appShellEl) appShellEl.style.display = "";
}

function showLogin() {
  if (appShellEl) appShellEl.style.display = "none";
  if (loginScreenEl) loginScreenEl.style.display = "flex";
}

// Kiểm tra session ngay khi tải trang — nếu máy đã đăng nhập trước đó
// (session Supabase tự lưu ở localStorage) thì vào thẳng app, không bắt
// đăng nhập lại mỗi lần mở trình duyệt/kiosk.
sb.auth.getSession().then(({ data }) => {
  if (data.session) {
    showApp();
  } else {
    showLogin();
  }
});

// Theo dõi thay đổi trạng thái đăng nhập (đăng nhập / đăng xuất / hết hạn)
sb.auth.onAuthStateChange((event, session) => {
  if (session) {
    showApp();
  } else {
    showLogin();
  }
});

loginFormEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErrorEl.textContent = "";
  loginSubmitEl.disabled = true;
  loginSubmitEl.textContent = "Đang đăng nhập...";

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  const { error } = await sb.auth.signInWithPassword({ email, password });

  loginSubmitEl.disabled = false;
  loginSubmitEl.textContent = "Đăng nhập";

  if (error) {
    loginErrorEl.textContent = "Sai email hoặc mật khẩu. Vui lòng thử lại.";
    return;
  }
  loginFormEl.reset();
});

document.getElementById("btn-logout")?.addEventListener("click", async () => {
  await sb.auth.signOut();
});

const SETTINGS_KEY = "dot_kham_settings_v1";

// ---------- Cài đặt mặc định của đợt khám (lưu localStorage theo máy) ----------
function getSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const defaults = {
    nguoi_quet: "",
    ageMode: "date", // "date" = ngày sinh chính xác | "year" = theo năm sinh
    dan_toc: "Kinh",
    doi_tuong: "",
    nguon_chi_tra: "",
    nhom_mau: "",
    nghe_nghiep: "",
    noi_lam_viec: "",
    ly_do_kham: "Khám sức khỏe định kỳ",
  };
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------- Helpers ngày tháng ----------
function parseDDMMYYYY(s) {
  if (!s || s.length !== 8 || !/^\d{8}$/.test(s)) return null;
  const dd = s.slice(0, 2), mm = s.slice(2, 4), yyyy = s.slice(4, 8);
  return `${yyyy}-${mm}-${dd}`; // ISO, phù hợp cột date của Postgres
}

function formatDateVN(iso) {
  if (!iso) return "…………………..";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function nowTimeVN() {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}

// ---------- Tiếng "tít" báo quét thành công ----------
function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1000;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.start(now);
    osc.stop(now + 0.16);
    osc.onended = () => ctx.close();
  } catch (e) {
    // Trình duyệt chặn AudioContext (chưa có tương tác người dùng) — bỏ qua, không quan trọng
  }
}

function calcTuoi(ngaySinhISO, mode) {
  if (!ngaySinhISO) return "";
  const today = new Date();
  const birth = new Date(ngaySinhISO);
  if (mode === "year") {
    return today.getFullYear() - birth.getFullYear();
  }
  let age = today.getFullYear() - birth.getFullYear();
  const mDiff = today.getMonth() - birth.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// Địa chỉ CCCD thường có dạng: "Thôn X, Xã Y, Huyện Z, Tỉnh T"
// Phiếu chỉ có 3 ô: Tỉnh/thành | Phường/xã | Số nhà/thôn/xóm
function splitDiaChi(diaChi) {
  const parts = (diaChi || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { soNha: "", phuongXa: "", tinh: "" };
  const tinh = parts[parts.length - 1] || "";
  const soNha = parts[0] || "";
  const phuongXa = parts.slice(1, parts.length - 1).join(", ");
  return { soNha, phuongXa, tinh };
}

// ---------- Phân tích chuỗi quét từ mã QR CCCD ----------
// Định dạng: CCCD|SoCMNDCu|HoTen|ddMMyyyy(sinh)|Gioi|DiaChi|ddMMyyyy(cap)|...
function parseQR(raw) {
  const parts = raw.split("|");
  const cccd = (parts[0] || "").trim();
  const hoTen = (parts[2] || "").trim();
  const ngaySinh = parseDDMMYYYY((parts[3] || "").trim());
  const gioi = (parts[4] || "").trim();
  const diaChi = (parts[5] || "").trim();
  const ngayCap = parseDDMMYYYY((parts[6] || "").trim());
  return { raw, cccd, hoTen, ngaySinh, gioi, diaChi, ngayCap };
}

// ============================================================
// TRANG 1 - TIẾP ĐÓN
// ============================================================

const qrInput = document.getElementById("qr-input");
const toast = document.getElementById("toast");
const warningBanner = document.getElementById("warning-banner");

const scanResultEl = document.getElementById("scan-result");
const srBadge = document.getElementById("scan-result-badge");
const srDup = document.getElementById("scan-result-dup");
const srSave = document.getElementById("scan-result-save");
const btnPrintScan = document.getElementById("btn-print-scan");
const btnClearScan = document.getElementById("btn-clear-scan");

function showToast(msg, type = "ok") {
  toast.textContent = msg;
  toast.className = "toast show " + type;
  setTimeout(() => (toast.className = "toast"), 2500);
}

// Hiện thông tin vừa quét lên khối kết quả (chưa in, chưa chắc đã lưu xong)
function showScanResult(data, tuoi, diaChiParts) {
  document.getElementById("sr-ho-ten").textContent = data.hoTen || "";
  document.getElementById("sr-gioi").textContent = data.gioi || "";
  const tuoiText = typeof tuoi === "number" ? ` (${tuoi} tuổi)` : "";
  document.getElementById("sr-ngay-sinh").textContent = formatDateVN(data.ngaySinh) + tuoiText;
  document.getElementById("sr-cccd").textContent = data.cccd || "";
  document.getElementById("sr-ngay-cap").textContent = formatDateVN(data.ngayCap);
  document.getElementById("sr-dia-chi").textContent = data.diaChi || "";

  srBadge.textContent = "Hợp lệ";
  srBadge.className = "badge-status ok";
  srDup.style.display = "none";
  srDup.textContent = "";
  srSave.textContent = "Đang lưu vào hệ thống…";
  srSave.className = "scan-result-save";

  scanResultEl.classList.add("show");
}

// Báo thẻ đã tồn tại trên hệ thống — không tự thêm bản ghi trùng
function showDuplicateWarning(existing) {
  srBadge.textContent = "⚠ Đã có trên hệ thống";
  srBadge.className = "badge-status warn";
  const ngay = existing?.ngay_tiep_don ? `ngày ${formatDateVN(existing.ngay_tiep_don)}` : "";
  const gio = existing?.gio ? ` lúc ${existing.gio.slice(0, 5)}` : "";
  srDup.textContent = `⚠ Thẻ CCCD này đã được tiếp đón${ngay ? " " + ngay : ""}${gio}. Hệ thống không lưu thêm bản ghi trùng — bạn vẫn có thể bấm "In phiếu" nếu cần in lại.`;
  srDup.style.display = "block";
}

function setSaveStatus(text, type) {
  srSave.textContent = text;
  srSave.className = "scan-result-save" + (type ? " " + type : "");
}

btnPrintScan?.addEventListener("click", () => window.print());
btnClearScan?.addEventListener("click", () => {
  scanResultEl.classList.remove("show");
  warningBanner.style.display = "none";
  qrInput?.focus();
});

function fillPrintTemplate(data, settings, tuoi, diaChiParts) {
  const genderNam = data.gioi === "Nam";
  document.getElementById("pt-ten-xa").textContent = window.APP_CONFIG.TEN_XA;
  document.getElementById("pt-ten-tram").textContent = window.APP_CONFIG.TEN_TRAM;
  document.getElementById("pt-ho-ten").textContent = data.hoTen.toUpperCase();
  document.getElementById("pt-gioi-nam").textContent = genderNam ? "☒" : "☐";
  document.getElementById("pt-gioi-nu").textContent = genderNam ? "☐" : "☒";
  document.getElementById("pt-ngay-sinh").textContent = formatDateVN(data.ngaySinh);
  document.getElementById("pt-tuoi").textContent = tuoi;
  document.getElementById("pt-cccd").textContent = data.cccd;
  document.getElementById("pt-ngay-cap").textContent = formatDateVN(data.ngayCap);
  document.getElementById("pt-noi-cap").textContent = "";
  document.getElementById("pt-dan-toc").textContent = settings.dan_toc;
  document.getElementById("pt-doi-tuong").textContent = settings.doi_tuong;
  document.getElementById("pt-nguon-chi-tra").textContent = settings.nguon_chi_tra;
  document.getElementById("pt-nhom-mau").textContent = settings.nhom_mau;
  document.getElementById("pt-tinh").textContent = diaChiParts.tinh;
  document.getElementById("pt-phuong-xa").textContent = diaChiParts.phuongXa;
  document.getElementById("pt-so-nha").textContent = diaChiParts.soNha;
  document.getElementById("pt-nghe-nghiep").textContent = settings.nghe_nghiep;
  document.getElementById("pt-noi-lam-viec").textContent = settings.noi_lam_viec;
  document.getElementById("pt-ly-do").textContent = settings.ly_do_kham;
}

async function handleScan(raw) {
  raw = raw.trim();
  if (!raw) return;

  const data = parseQR(raw);
  const settings = getSettings();

  if (!settings.nguoi_quet) {
    showToast("⚠ Chưa chọn người quét — vào Cấu hình đợt khám để chọn", "err");
  }

  if (!data.cccd || !data.hoTen) {
    showToast("⚠ Không đọc được dữ liệu QR, thử quét lại", "err");
    return;
  }

  playBeep();

  const tuoi = calcTuoi(data.ngaySinh, settings.ageMode);
  warningBanner.style.display = "none";
  if (typeof tuoi === "number" && tuoi < 18) {
    warningBanner.textContent = `⚠ ${data.hoTen} — ${tuoi} tuổi theo dữ liệu CCCD. Mẫu phiếu đang dùng chỉ dành cho người từ 18 tuổi trở lên.`;
    warningBanner.style.display = "block";
  }

  const diaChiParts = splitDiaChi(data.diaChi);
  fillPrintTemplate(data, settings, tuoi, diaChiParts);

  // Hiện thông tin ngay lập tức (chưa in — chỉ in khi bấm nút "In phiếu tiếp đón")
  showScanResult(data, tuoi, diaChiParts);

  qrInput.value = "";
  qrInput.focus();

  // Kiểm tra thẻ đã tồn tại trên hệ thống chưa, để tránh lưu trùng lặp
  let existing = null;
  try {
    const { data: found, error: checkErr } = await sb
      .from("tiep_don")
      .select("id, ngay_tiep_don, gio")
      .eq("cccd", data.cccd)
      .order("created_at", { ascending: false })
      .limit(1);
    if (checkErr) console.error(checkErr);
    if (found && found.length) existing = found[0];
  } catch (e) {
    console.error(e);
  }

  if (existing) {
    showDuplicateWarning(existing);
    showToast(`⚠ ${data.hoTen} đã có trên hệ thống, không lưu trùng`, "err");
    return;
  }

  // Lưu vào Supabase ngay, nhanh nhất có thể
  const row = {
    ma_qr: data.raw,
    ho_ten: data.hoTen,
    ngay_sinh: data.ngaySinh,
    tuoi: typeof tuoi === "number" ? tuoi : null,
    gioi: data.gioi,
    cccd: data.cccd,
    ngay_cap: data.ngayCap,
    dia_chi: data.diaChi,
    so_nha_thon: diaChiParts.soNha,
    phuong_xa: diaChiParts.phuongXa,
    tinh_thanh: diaChiParts.tinh,
    dan_toc: settings.dan_toc,
    doi_tuong: settings.doi_tuong,
    nguon_chi_tra: settings.nguon_chi_tra,
    nhom_mau: settings.nhom_mau,
    nghe_nghiep: settings.nghe_nghiep,
    noi_lam_viec: settings.noi_lam_viec,
    ly_do_kham: settings.ly_do_kham,
    nhom_tuoi: "18+",
    nguoi_quet: settings.nguoi_quet || null,
  };

  const { error } = await sb.from("tiep_don").insert(row);
  if (error) {
    console.error(error);
    setSaveStatus("✗ Lỗi lưu dữ liệu, kiểm tra lại kết nối!", "err");
    showToast(`✗ Lỗi lưu dữ liệu: ${data.hoTen}`, "err");
  } else {
    setSaveStatus("✓ Đã lưu vào hệ thống", "ok");
    showToast(`✓ Đã tiếp đón: ${data.hoTen}`, "ok");
  }
}

if (qrInput) {
  qrInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(qrInput.value);
    }
  });
  // Chỉ tự động focus lại ô quét QR khi: đang ở trang tiếp đón,
  // popup cấu hình KHÔNG mở, và không phải đang bấm vào popup/nút/nav khác.
  // (Trước đây nghe click trên TOÀN TRANG nên mỗi lần bấm vào dropdown/ô
  // nhập trong popup cấu hình lại bị cướp focus về ô quét QR đang ẩn.)
  window.addEventListener("click", (e) => {
    const isReceptionActive = document
      .getElementById("page-reception")
      ?.classList.contains("active");
    const isSettingsOpen = settingsModal && settingsModal.style.display === "flex";
    const isCameraOpen = document.getElementById("camera-modal")?.style.display === "flex";
    if (!isReceptionActive || isSettingsOpen || isCameraOpen) return;
    if (e.target.closest("#settings-modal, .modal, button, select, a")) return;
    qrInput.focus();
  });
  qrInput.focus();
}

// ---------- Modal cài đặt đợt khám ----------
const settingsModal = document.getElementById("settings-modal");
const settingsForm = document.getElementById("settings-form");
const nguoiQuetSelect = document.getElementById("field-nguoi-quet");
const currentNguoiQuetEl = document.getElementById("current-nguoi-quet");

// Đổ danh sách tên nhân viên (khai báo trong config.js) vào ô chọn
function populateNguoiQuetSelect() {
  if (!nguoiQuetSelect) return;
  const list = window.APP_CONFIG.DANH_SACH_NGUOI_QUET || [];
  nguoiQuetSelect.innerHTML =
    `<option value="">— Chọn tên —</option>` +
    list.map((ten) => `<option value="${ten}">${ten}</option>`).join("");
}
populateNguoiQuetSelect();

// Hiện tên người quét đang được chọn trên thanh công cụ trang Tiếp đón,
// để biết ngay đang tiếp đón dưới tên ai mà không cần mở lại cấu hình.
function updateCurrentNguoiQuetLabel() {
  if (!currentNguoiQuetEl) return;
  const s = getSettings();
  currentNguoiQuetEl.textContent = s.nguoi_quet
    ? `Người quét: ${s.nguoi_quet}`
    : "⚠ Chưa chọn người quét — mở Cấu hình đợt khám để chọn";
}
updateCurrentNguoiQuetLabel();

function openSettings() {
  const s = getSettings();
  for (const key of Object.keys(s)) {
    const el = settingsForm.elements[key];
    if (el) el.value = s[key];
  }
  settingsModal.style.display = "flex";
}

function closeSettings() {
  settingsModal.style.display = "none";
}

if (settingsForm) {
  settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(settingsForm);
    const s = Object.fromEntries(fd.entries());
    saveSettings(s);
    updateCurrentNguoiQuetLabel();
    closeSettings();
    qrInput.focus();
    showToast("Đã lưu cấu hình đợt khám", "ok");
  });
}

// ---------- Quét QR bằng camera ----------
// Cách Zalo quét nhanh & chính xác: (1) xin camera độ phân giải cao, (2) bật lấy nét
// liên tục (continuous autofocus), (3) ZOOM/CẮT vào đúng vùng khung ngắm trước khi
// giải mã — vì mã QR trên CCCD rất nhỏ so với cả khung hình, nếu đưa nguyên khung hình
// độ phân giải thấp cho bộ giải mã thì mã QR chỉ chiếm vài chục điểm ảnh, rất khó đọc.
// Ở đây mô phỏng lại bằng: getUserMedia độ phân giải cao + zoom phần cứng (nếu máy hỗ
// trợ) + luôn crop vùng trung tâm (khớp khung ngắm trên màn hình) rồi phóng to lên một
// canvas làm việc trước khi đưa cho ZXing giải mã — thay vì dùng chế độ quét mặc định
// của thư viện (chỉ đọc nguyên khung hình gốc, không zoom).
const cameraModal = document.getElementById("camera-modal");
const cameraVideo = document.getElementById("camera-video");
const cameraStatusEl = document.getElementById("camera-status");
const btnOpenCamera = document.getElementById("btn-open-camera");
const btnCloseCamera = document.getElementById("btn-close-camera");
const btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnTorch = document.getElementById("btn-torch");
const btnZoomIn = document.getElementById("btn-zoom-in");
const btnZoomOut = document.getElementById("btn-zoom-out");
const zoomLabel = document.getElementById("zoom-label");

let cameraDevices = [];
let currentCameraIndex = 0;
let cameraBusy = false; // chặn xử lý trùng khi vừa quét được 1 mã
let activeTrack = null;
let zoomCapabilities = null; // { min, max, step } nếu camera hỗ trợ zoom phần cứng
let currentZoom = 1;
let torchOn = false;

let scanLoopHandle = null;
let qrCoreReader = null; // bộ giải mã QR mức thấp, tự quản lý crop/zoom
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
let lastDecodeAt = 0;
let attemptIndex = 0; // luân phiên giữa các tỉ lệ crop mỗi lần thử giải mã
const DECODE_INTERVAL_MS = 90; // ~11 lần/giây cho pipeline ZXing (đủ nhanh, không quá tải CPU)
const NATIVE_DECODE_INTERVAL_MS = 55; // ~18 lần/giây cho BarcodeDetector gốc (rẻ hơn nhiều, tương đương Zalo)

// Cờ chống race-condition: BarcodeDetector.detect() là async, có thể vẫn đang
// chạy khi người dùng đã đóng camera — dùng cờ này để callback tự huỷ thay vì
// lỡ gọi handleScan() hoặc lên lịch frame tiếp theo sau khi camera đã tắt.
let cameraScanActive = false;

// ---------- Quét QR bằng API gốc của hệ điều hành (BarcodeDetector) ----------
// Đây là cách Zalo/ML Kit quét nhanh & chính xác: dùng bộ giải mã native của
// Android/Chrome (được OS tối ưu bằng phần cứng) thay vì decode bằng JS thuần.
// Chrome trên Android hỗ trợ tốt; Safari/iOS hiện chưa hỗ trợ nên sẽ tự động
// rơi xuống pipeline ZXing crop/zoom thủ công bên dưới.
let nativeQrSupported = null; // cache kết quả kiểm tra, tránh hỏi lại mỗi lần mở camera
let nativeDetector = null;

async function supportsNativeBarcodeDetector() {
  if (!("BarcodeDetector" in window)) return false;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes("qr_code");
  } catch {
    return false;
  }
}

function nativeDecodeTick(ts) {
  if (!cameraScanActive) return;
  if (!cameraVideo || cameraVideo.readyState < 2 || !nativeDetector) {
    scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    return;
  }
  if (ts - lastDecodeAt < NATIVE_DECODE_INTERVAL_MS) {
    scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    return;
  }
  lastDecodeAt = ts;

  nativeDetector
    .detect(cameraVideo)
    .then((codes) => {
      if (!cameraScanActive) return; // camera đã bị đóng trong lúc chờ detect()
      if (codes && codes.length && !cameraBusy) {
        cameraBusy = true;
        const text = codes[0].rawValue;
        cameraStatusEl.style.color = "var(--ok)";
        cameraStatusEl.textContent = "✓ Đã nhận mã QR";
        try { navigator.vibrate?.(70); } catch {}
        closeCamera();
        handleScan(text);
        return;
      }
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    })
    .catch(() => {
      if (!cameraScanActive) return;
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    });
}

// Vài phiên bản/bản dựng của thư viện có thể không lộ đủ các lớp mức thấp
// (HTMLCanvasElementLuminanceSource, BinaryBitmap, HybridBinarizer, QRCodeReader)
// cần cho việc tự crop/zoom trước khi giải mã. Kiểm tra trước — nếu thiếu, tự
// động chuyển sang chế độ quét dự phòng bằng BrowserQRCodeReader (đọc nguyên
// khung hình, không crop) để tính năng luôn hoạt động, không im lặng thất bại.
function canUseManualCropDecode() {
  return (
    window.ZXing &&
    typeof ZXing.HTMLCanvasElementLuminanceSource === "function" &&
    typeof ZXing.BinaryBitmap === "function" &&
    typeof ZXing.HybridBinarizer === "function" &&
    typeof ZXing.QRCodeReader === "function"
  );
}

let fallbackReader = null;
let fallbackControls = null;

async function pickBestDeviceId() {
  try {
    cameraDevices = await ZXing.BrowserCodeReader.listVideoInputDevices();
  } catch {
    cameraDevices = [];
  }
  if (!cameraDevices.length) return null;
  // Ưu tiên camera sau (thường ghi "back"/"rear"/"environment" trong tên thiết bị)
  const backIdx = cameraDevices.findIndex((d) => /back|rear|environment|sau/i.test(d.label));
  currentCameraIndex = backIdx >= 0 ? backIdx : 0;
  btnSwitchCamera.style.display = cameraDevices.length > 1 ? "inline-block" : "none";
  return cameraDevices[currentCameraIndex].deviceId;
}

function setupTrackControls(track) {
  zoomCapabilities = null;
  torchOn = false;
  currentZoom = 1;
  btnTorch.style.display = "none";
  btnTorch.textContent = "🔦 Đèn flash";
  btnZoomIn.style.display = "none";
  btnZoomOut.style.display = "none";
  zoomLabel.style.display = "none";

  const caps = track.getCapabilities ? track.getCapabilities() : {};

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoomCapabilities = caps.zoom;
    btnZoomIn.style.display = "inline-block";
    btnZoomOut.style.display = "inline-block";
    zoomLabel.style.display = "inline-block";
    // Tự phóng to NHẸ ngay từ đầu (giống Zalo zoom sẵn trước khi quét), để mã QR
    // trên thẻ chiếm nhiều diện tích khung hình hơn ngay khi mở camera — không
    // zoom quá tay vì còn phần crop phần mềm phía dưới hỗ trợ thêm.
    const auto = caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.2;
    applyZoom(auto);
  } else {
    zoomLabel.textContent = "";
  }

  if (caps.torch) {
    btnTorch.style.display = "inline-block";
  }
}

async function applyZoom(z) {
  if (!activeTrack || !zoomCapabilities) return;
  z = Math.min(zoomCapabilities.max, Math.max(zoomCapabilities.min, z));
  try {
    await activeTrack.applyConstraints({ advanced: [{ zoom: z }] });
    currentZoom = z;
    zoomLabel.textContent = z.toFixed(1) + "x";
  } catch {
    // Một số trình duyệt/camera báo hỗ trợ zoom nhưng vẫn từ chối áp constraint — bỏ qua
  }
}

function buildCoreReader() {
  return new ZXing.QRCodeReader();
}

function decodeTick(ts) {
  if (!cameraScanActive) return;
  if (!cameraVideo || cameraVideo.readyState < 2 || !qrCoreReader) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }
  if (ts - lastDecodeAt < DECODE_INTERVAL_MS) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }
  lastDecodeAt = ts;

  const vw = cameraVideo.videoWidth;
  const vh = cameraVideo.videoHeight;
  if (!vw || !vh) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }

  // QUAN TRỌNG: nếu camera đã zoom phần cứng (currentZoom > 1) thì khung hình
  // video (vw x vh) đã LÀ ảnh phóng to sẵn rồi — không được chia thêm cho
  // currentZoom lần nữa, nếu không sẽ cắt chồng 2 lần zoom, cắt mất luôn góc
  // định vị của mã QR dù mắt nhìn preview vẫn thấy ảnh rất rõ (đây là lỗi cũ).
  // Mỗi lượt thử luân phiên 3 tỉ lệ crop khác nhau (toàn khung / vừa / sát) để
  // bắt được mã QR dù người dùng đưa thẻ gần hay xa, không cần canh khung chuẩn.
  attemptIndex = (attemptIndex + 1) % 3;
  const cropRatio = attemptIndex === 0 ? 1.0 : attemptIndex === 1 ? 0.7 : 0.42;
  const side = Math.min(vw, vh) * cropRatio;
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  const outSize = 800;
  if (scanCanvas.width !== outSize) {
    scanCanvas.width = outSize;
    scanCanvas.height = outSize;
    scanCtx.imageSmoothingEnabled = false; // giữ cạnh sắc nét, không làm mờ khi phóng to
  }
  scanCtx.drawImage(cameraVideo, sx, sy, side, side, 0, 0, outSize, outSize);

  try {
    const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(scanCanvas);
    const binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const result = qrCoreReader.decode(binaryBitmap, hints);
    if (result && !cameraBusy) {
      cameraBusy = true;
      const text = result.getText();
      try { navigator.vibrate?.(70); } catch {}
      cameraStatusEl.style.color = "var(--ok)";
      cameraStatusEl.textContent = "✓ Đã nhận mã QR";
      closeCamera();
      handleScan(text);
      return; // dừng vòng lặp, không cần requestAnimationFrame tiếp
    }
  } catch {
    // Chưa thấy mã hợp lệ trong khung hình này — bình thường, thử lại khung kế tiếp
  }

  scanLoopHandle = requestAnimationFrame(decodeTick);
}

async function startCameraScan(deviceId) {
  stopCameraScan();
  cameraStatusEl.textContent = "";
  cameraBusy = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatusEl.textContent = "✗ Trình duyệt không hỗ trợ camera, hoặc trang chưa chạy qua HTTPS.";
    return;
  }

  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: "environment" } };
  // Xin độ phân giải cao — mã QR càng nhiều điểm ảnh càng dễ giải mã.
  videoConstraints.width = { ideal: 3840 };
  videoConstraints.height = { ideal: 3840 };
  // Khung hình/giây cao giúp bộ giải mã (native lẫn ZXing) có nhiều cơ hội bắt
  // được mã QR hơn mỗi giây, đặc biệt khi tay người dùng hơi rung khi cầm thẻ.
  videoConstraints.frameRate = { ideal: 30 };
  videoConstraints.advanced = [{ focusMode: "continuous" }];

  if (nativeQrSupported === null) {
    nativeQrSupported = await supportsNativeBarcodeDetector();
  }

  // ---------- Nhánh 1: BarcodeDetector gốc của hệ điều hành (nhanh & chính xác
  // nhất, tương đương công nghệ Zalo dùng) — ưu tiên khi trình duyệt hỗ trợ ----------
  if (nativeQrSupported) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      cameraVideo.srcObject = stream;
      await cameraVideo.play();

      activeTrack = stream.getVideoTracks()[0];
      try {
        const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.includes("continuous")) {
          await activeTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        }
      } catch {}
      setupTrackControls(activeTrack);

      nativeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      cameraScanActive = true;
      lastDecodeAt = 0;
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    } catch (e) {
      reportCameraError(e);
    }
    return;
  }

  if (!window.ZXing) {
    cameraStatusEl.textContent = "✗ Không tải được thư viện quét mã. Kiểm tra kết nối mạng.";
    return;
  }

  // ---------- Nhánh 2 (dự phòng, ví dụ Safari/iPhone chưa hỗ trợ BarcodeDetector):
  // nếu trình duyệt/thư viện không lộ đủ API mức thấp để tự crop/zoom trước khi
  // giải mã, dùng thẳng decodeFromConstraints (API đã kiểm chứng luôn hoạt động)
  // — đọc nguyên khung hình, không tự crop phần mềm được, nhưng vẫn đọc được mã,
  // chỉ là kém nhạy hơn với mã QR nhỏ/ở xa. ----------
  if (!canUseManualCropDecode()) {
    try {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      fallbackReader = new ZXing.BrowserQRCodeReader(hints, { delayBetweenScanAttempts: 80 });
      cameraScanActive = true;
      fallbackControls = await fallbackReader.decodeFromConstraints(
        { video: videoConstraints, audio: false },
        cameraVideo,
        (result) => {
          if (!cameraScanActive) return;
          if (result && !cameraBusy) {
            cameraBusy = true;
            try { navigator.vibrate?.(70); } catch {}
            cameraStatusEl.style.color = "var(--ok)";
            cameraStatusEl.textContent = "✓ Đã nhận mã QR";
            closeCamera();
            handleScan(result.getText());
          }
        }
      );
      activeTrack = cameraVideo.srcObject?.getVideoTracks?.()[0] || null;
      if (activeTrack) setupTrackControls(activeTrack);
    } catch (e) {
      reportCameraError(e);
    }
    return;
  }

  // ---------- Nhánh 3 (dự phòng cuối): ZXing tự crop/zoom thủ công ----------
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    cameraVideo.srcObject = stream;
    await cameraVideo.play();

    activeTrack = stream.getVideoTracks()[0];
    // Nếu trình duyệt không chấp nhận focusMode trong constraint ban đầu, thử áp lại riêng
    try {
      const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        await activeTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch {}
    setupTrackControls(activeTrack);

    qrCoreReader = buildCoreReader();
    cameraScanActive = true;
    lastDecodeAt = 0;
    scanLoopHandle = requestAnimationFrame(decodeTick);
  } catch (e) {
    reportCameraError(e);
  }
}

function reportCameraError(e) {
  console.error(e);
  let msg = "✗ Không thể mở camera.";
  if (e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError")) {
    msg = "✗ Chưa được cấp quyền camera. Vui lòng cho phép truy cập camera cho trang này.";
  } else if (e && e.name === "NotFoundError") {
    msg = "✗ Không tìm thấy camera trên thiết bị này.";
  } else if (e && e.name === "NotReadableError") {
    msg = "✗ Camera đang được ứng dụng khác sử dụng.";
  }
  cameraStatusEl.style.color = "var(--err)";
  cameraStatusEl.textContent = msg;
}

function stopCameraScan() {
  cameraScanActive = false;
  if (scanLoopHandle) {
    cancelAnimationFrame(scanLoopHandle);
    scanLoopHandle = null;
  }
  qrCoreReader = null;
  nativeDetector = null;
  if (fallbackControls) {
    try { fallbackControls.stop(); } catch {}
    fallbackControls = null;
  }
  if (fallbackReader) {
    try { fallbackReader.reset(); } catch {}
    fallbackReader = null;
  }
  if (cameraVideo && cameraVideo.srcObject) {
    cameraVideo.srcObject.getTracks().forEach((t) => t.stop());
    cameraVideo.srcObject = null;
  }
  activeTrack = null;
  zoomCapabilities = null;
}

async function openCamera() {
  if (!cameraModal) return;
  cameraModal.style.display = "flex";
  const deviceId = await pickBestDeviceId();
  startCameraScan(deviceId || undefined);
}

function closeCamera() {
  stopCameraScan();
  if (cameraModal) cameraModal.style.display = "none";
}

// Chạm vào khung camera để lấy nét đúng vị trí đó (nếu máy hỗ trợ) — hữu ích khi
// đưa thẻ CCCD lại gần, camera lấy nét macro chưa kịp bắt nét khu vực mã QR.
cameraVideo?.addEventListener("click", async (e) => {
  if (!activeTrack) return;
  try {
    const rect = cameraVideo.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
    if (caps.pointsOfInterest) {
      const advanced = [{ pointsOfInterest: [{ x, y }] }];
      if (caps.focusMode && caps.focusMode.includes("single-shot")) {
        advanced[0].focusMode = "single-shot";
      }
      await activeTrack.applyConstraints({ advanced });
    }
  } catch {}
});

btnOpenCamera?.addEventListener("click", openCamera);
btnCloseCamera?.addEventListener("click", () => {
  closeCamera();
  qrInput?.focus();
});
btnSwitchCamera?.addEventListener("click", () => {
  if (!cameraDevices.length) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameraDevices.length;
  startCameraScan(cameraDevices[currentCameraIndex].deviceId);
});
btnZoomIn?.addEventListener("click", () => {
  if (!zoomCapabilities) return;
  const step = zoomCapabilities.step || (zoomCapabilities.max - zoomCapabilities.min) / 10;
  applyZoom(currentZoom + step);
});
btnZoomOut?.addEventListener("click", () => {
  if (!zoomCapabilities) return;
  const step = zoomCapabilities.step || (zoomCapabilities.max - zoomCapabilities.min) / 10;
  applyZoom(currentZoom - step);
});
btnTorch?.addEventListener("click", async () => {
  if (!activeTrack) return;
  try {
    await activeTrack.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    btnTorch.textContent = torchOn ? "🔦 Tắt đèn" : "🔦 Đèn flash";
  } catch {
    showToast("Thiết bị không hỗ trợ bật đèn flash qua trình duyệt", "err");
  }
});
window.addEventListener("beforeunload", stopCameraScan);



let allRows = [];
let hideExported = true;

async function loadList() {
  const dateFilter = document.getElementById("filter-date").value;
  let query = sb.from("tiep_don").select("*").order("created_at", { ascending: false });
  if (dateFilter) query = query.eq("ngay_tiep_don", dateFilter);
  const { data, error } = await query.limit(500);
  if (error) {
    console.error(error);
    return;
  }
  allRows = data;
  renderList();
}

function renderList() {
  const term = document.getElementById("search-box").value.trim().toLowerCase();
  const tbody = document.getElementById("list-body");
  tbody.innerHTML = "";

  let rows = allRows.filter((r) => (hideExported ? !r.da_nhap_v20 : true));
  if (term) {
    rows = rows.filter((r) =>
      [r.ho_ten, r.cccd, r.dia_chi].filter(Boolean).join(" ").toLowerCase().includes(term)
    );
  }

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    if (r.da_nhap_v20) tr.classList.add("exported");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.gio ? r.gio.slice(0, 5) : ""}</td>
      <td>${r.ngay_tiep_don || ""}</td>
      <td>${r.ho_ten || ""}</td>
      <td>${formatDateVN(r.ngay_sinh)}</td>
      <td>${r.gioi || ""}</td>
      <td class="cccd-cell">${r.cccd || ""}</td>
      <td>${r.dia_chi || ""}</td>
      <td>${r.nguoi_quet || ""}</td>
      <td>${r.da_nhap_v20 ? "✓ Đã nhập" : "—"}</td>
      <td><button type="button" class="btn-print-row" data-id="${r.id}">🖨 In phiếu</button></td>
    `;
    tr.addEventListener("click", () => copyRow(r, tr));
    tr.querySelector(".btn-print-row")?.addEventListener("click", (e) => {
      e.stopPropagation(); // không cho kích hoạt copyRow khi bấm nút in
      printRow(r);
    });
    tbody.appendChild(tr);
  });
}

// ---------- In lại phiếu khám sức khỏe từ danh sách ----------
// Dùng chính dữ liệu đã lưu tại thời điểm tiếp đón (không phụ thuộc cấu hình
// hiện tại của máy), để phiếu in ra khớp với những gì đã ghi nhận ban đầu.
function printRow(row) {
  const data = {
    hoTen: row.ho_ten || "",
    gioi: row.gioi || "",
    ngaySinh: row.ngay_sinh || "",
    cccd: row.cccd || "",
    ngayCap: row.ngay_cap || "",
  };
  const settingsFromRow = {
    dan_toc: row.dan_toc || "",
    doi_tuong: row.doi_tuong || "",
    nguon_chi_tra: row.nguon_chi_tra || "",
    nhom_mau: row.nhom_mau || "",
    nghe_nghiep: row.nghe_nghiep || "",
    noi_lam_viec: row.noi_lam_viec || "",
    ly_do_kham: row.ly_do_kham || "",
  };
  const diaChiParts = {
    soNha: row.so_nha_thon || "",
    phuongXa: row.phuong_xa || "",
    tinh: row.tinh_thanh || "",
  };
  const tuoi = row.tuoi ?? "";

  fillPrintTemplate(data, settingsFromRow, tuoi, diaChiParts);
  window.print();
}

async function copyRow(row, trEl) {
  try {
    await navigator.clipboard.writeText(row.ma_qr);
  } catch (e) {
    console.error("Clipboard error", e);
  }

  trEl.classList.add("copied");

  const { error } = await sb
    .from("tiep_don")
    .update({ da_nhap_v20: true, thoi_gian_nhap_v20: new Date().toISOString() })
    .eq("id", row.id);

  if (error) console.error(error);

  setTimeout(() => {
    row.da_nhap_v20 = true;
    row.thoi_gian_nhap_v20 = new Date().toISOString();
    renderList();
  }, 2000);
}

document.getElementById("search-box")?.addEventListener("input", renderList);
document.getElementById("filter-date")?.addEventListener("change", loadList);
document.getElementById("toggle-hide-exported")?.addEventListener("change", (e) => {
  hideExported = e.target.checked;
  renderList();
});

// ---------- Realtime: tự cập nhật khi có tiếp đón mới từ máy khác ----------
sb.channel("tiep_don-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "tiep_don" }, () => {
    if (document.getElementById("page-list").classList.contains("active")) {
      loadList();
    }
  })
  .subscribe();

// ============================================================
// ĐIỀU HƯỚNG 2 TRANG
// ============================================================

function switchPage(name) {
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));
  document.getElementById(`page-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");
  if (name !== "reception") closeCamera();
  if (name === "list") loadList();
  if (name === "reception") qrInput?.focus();
}

document.getElementById("nav-reception")?.addEventListener("click", () => switchPage("reception"));
document.getElementById("nav-list")?.addEventListener("click", () => switchPage("list"));
document.getElementById("btn-settings")?.addEventListener("click", openSettings);
document.getElementById("btn-close-settings")?.addEventListener("click", closeSettings);

// Mặc định: mở tab danh sách với ngày hôm nay
const today = new Date();
const iso = today.toISOString().slice(0, 10);
const filterDateEl = document.getElementById("filter-date");
if (filterDateEl) filterDateEl.value = iso;

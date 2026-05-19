// ---- Utility ----

function $(id) { return document.getElementById(id); }
function fmt(n) { return Number(n).toLocaleString("ja-JP"); }
function fmtPrice(n) { return "¥" + fmt(n); }
function skuLink(sku) {
  if (!sku) return "−";
  const url = `https://sellercentral.amazon.co.jp/myinventory/inventory?fulfilledBy=all&page=1&pageSize=100&searchField=all&searchTerm=${encodeURIComponent(sku)}&sort=date_created_desc&status=all`;
  return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--blue)">${esc(sku)}</a>`;
}

// ---- Settings & Reorder Calc ----

let appSettings = { lead_time_months: 1.5, target_stock_months: 2.0 };
let pendingQtys = {};

async function loadSettings() {
  try { appSettings = await api("GET", "/api/settings"); } catch(e) {}
}

async function loadPendingQtys() {
  try { pendingQtys = await api("GET", "/api/pending-quantities"); } catch(e) { pendingQtys = {}; }
}

function calcReorderPoint(p) {
  return Math.ceil((p.monthly_sales || 0) * appSettings.lead_time_months);
}

function calcOrderQty(p) {
  if (p.discontinued) return 0;
  const pending = pendingQtys[p.id] || 0;
  return Math.max(0, Math.ceil((p.monthly_sales || 0) * appSettings.lead_time_months) - (p.stock || 0) - pending);
}

function settingsLabel() {
  return `リードタイム: ${appSettings.lead_time_months}ヶ月 / 目標在庫: ${appSettings.target_stock_months}ヶ月`;
}

let toastTimer;
function toast(msg, type = "success") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add("hidden"); }, 3000);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- Navigation ----

let currentPage = "dashboard";

document.querySelectorAll(".nav-link").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    navigateTo(a.dataset.page);
  });
});

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll(".nav-link").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${page}`));
  loadPage(page);
}

function loadPage(page) {
  if (page === "dashboard") loadDashboard();
  else if (page === "products") loadProducts();
  else if (page === "inventory") loadInventory();
  else if (page === "orders") loadOrders();
  else if (page === "suppliers") loadSuppliers();
  else if (page === "r-dashboard") loadRakutenDashboard();
  else if (page === "r-products") loadRakutenProducts();
  else if (page === "r-orders") loadRakutenOrdersPage();
  else if (page === "sm-dashboard") loadSelmonDashboard();
  else if (page === "sm-products") loadSelmonProducts();
  else if (page === "y-dashboard") loadYahooDashboard();
  else if (page === "y-products") loadYahooProducts();
  else if (page.startsWith("ch-")) loadChannelPage(page.slice(3));
}

// ---- Dashboard ----

async function loadDashboard() {
  const [summary, lowStock, allProducts] = await Promise.all([
    api("GET", "/api/reports/summary"),
    api("GET", "/api/products/low-stock"),
    api("GET", "/api/products?limit=9999"),
  ]);

  $("stat-grid").innerHTML = `
    <div class="stat-card"><div class="label">総商品数</div><div class="value">${fmt(summary.total_products)}</div></div>
    <div class="stat-card warning"><div class="label">在庫不足</div><div class="value">${fmt(summary.low_stock_count)}</div></div>
    <div class="stat-card info"><div class="label">進行中の発注</div><div class="value">${fmt(summary.pending_orders)}</div></div>
    <div class="stat-card"><div class="label">入庫数</div><div class="value">${fmt(summary.recent_in)}</div></div>
  `;

  if (lowStock.length === 0) {
    $("low-stock-list").innerHTML = `<div class="empty">在庫不足の商品はありません</div>`;
  } else {
    $("low-stock-list").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>商品名</th><th>バリエーション</th><th>SKU</th><th>在庫数</th><th>発注点</th><th></th></tr></thead>
          <tbody>
            ${lowStock.map(p => `
              <tr class="${p.stock === 0 ? "low-stock" : ""}">
                <td>${esc(p.title)}</td>
                <td>${esc(p.variation)}</td>
                <td>${skuLink(p.sku || p.nf_sku)}</td>
                <td style="color:var(--red);font-weight:700">${fmt(p.stock)}</td>
                <td>${fmt(p.reorder_point)}</td>
                <td><button class="btn btn-sm btn-primary" onclick="openOrderModal(${p.id})">発注</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  const lbl = $("reorder-settings-label");
  if (lbl) lbl.textContent = settingsLabel();

  const suggestions = allProducts.items
    .map(p => ({ ...p, _oq: calcOrderQty(p), _rp: calcReorderPoint(p) }))
    .filter(p => p._oq > 0)
    .sort((a, b) => b._oq - a._oq);

  if (suggestions.length === 0) {
    $("reorder-list").innerHTML = `<div class="empty">発注が必要な商品はありません</div>`;
  } else {
    $("reorder-list").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>商品名</th><th>バリエーション</th><th>SKU</th><th>在庫数</th><th style="color:var(--blue)">発注済み</th><th style="color:var(--red)">発注数</th><th></th></tr></thead>
          <tbody>
            ${suggestions.map(p => `
              <tr class="${p.stock === 0 ? "low-stock" : ""}">
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
                <td>${esc(p.variation)}</td>
                <td>${skuLink(p.sku || p.nf_sku)}</td>
                <td style="font-weight:600">${fmt(p.stock)}</td>
                <td style="color:var(--blue);cursor:pointer;text-decoration:underline dotted" title="クリックして編集" onclick="editManualPending(${p.id}, ${pendingQtys[p.id] ?? 'null'})">${pendingQtys[p.id] ? fmt(pendingQtys[p.id]) : "−"}${p.manual_pending != null ? " ✎" : ""}</td>
                <td style="font-weight:700;color:var(--red)">${fmt(p._oq)}</td>
                <td><button class="btn btn-sm btn-primary" onclick="openOrderModal(${p.id})">発注</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }
}

// ---- Products ----

function daysSince(dateStr) {
  if (!dateStr) return "−";
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  return diff >= 0 ? fmt(diff) + "日" : "−";
}

let productPage = 1;
let pageSize = 50;
let productSearch = "";
let productStockFilter = "";
let sortBy = "title";
let sortDir = "asc";

const COLUMNS = [
  { key: "title",           label: "商品名",       sortable: true },
  { key: "variation",       label: "バリエーション", sortable: true },
  { key: "sku",             label: "SKU",          sortable: true },
  { key: "sale_start_date", label: "販売開始日",    sortable: true },
  { key: "_days_since",     label: "経過日数",      sortable: false },
  { key: "cost_price",    label: "仕入価格",    sortable: true },
  { key: "selling_price", label: "販売価格",    sortable: true },
  { key: "stock",         label: "在庫数",      sortable: true },
  { key: "_pending",      label: "発注中",      sortable: false },
  { key: "_total_stock",  label: "合計在庫",    sortable: false },
  { key: "reorder_point", label: "発注点",      sortable: true },
  { key: "_order_qty",    label: "発注数",      sortable: false },
  { key: "monthly_sales", label: "月間販売数",  sortable: true },
  { key: "sessions",      label: "セッション数",  sortable: true },
  { key: "order_count",   label: "注文件数",     sortable: true },
  { key: "bulk_rate",     label: "まとめ買い率",  sortable: true },
  { key: "_discontinued", label: "終売",         sortable: false },
  { key: "_actions",      label: "",            sortable: false },
];

function sortIcon(key) {
  if (sortBy !== key) return '<span style="color:var(--gray-300);margin-left:4px">⇅</span>';
  return sortDir === "asc"
    ? '<span style="color:var(--blue);margin-left:4px">↑</span>'
    : '<span style="color:var(--blue);margin-left:4px">↓</span>';
}

function onSortClick(key) {
  if (sortBy === key) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortBy = key;
    sortDir = "asc";
  }
  productPage = 1;
  loadProducts();
}

async function loadProducts() {
  await loadPendingQtys();
  const limit = pageSize === 0 ? 9999 : pageSize;
  const offset = pageSize === 0 ? 0 : (productPage - 1) * pageSize;
  const params = new URLSearchParams({
    search: productSearch,
    stock_filter: productStockFilter,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit,
    offset,
  });
  const data = await api("GET", `/api/products?${params}`);
  renderProductTable(data.items);
  if (pageSize === 0) {
    $("product-pagination").innerHTML = `<span style="color:var(--gray-500);font-size:12px">全${fmt(data.total)}件表示中</span>`;
  } else {
    renderPagination(data.total, productPage, pageSize, p => { productPage = p; loadProducts(); });
  }
}

function renderProductTable(items) {
  const thStyle = "cursor:pointer;user-select:none;white-space:nowrap";
  const headers = COLUMNS.map(c =>
    c.sortable
      ? `<th style="${thStyle}" onclick="onSortClick('${c.key}')">${c.label}${sortIcon(c.key)}</th>`
      : `<th>${c.label}</th>`
  ).join("");

  if (items.length === 0) {
    $("product-table-wrap").innerHTML = `
      <div class="table-wrap"><table><thead><tr>${headers}</tr></thead></table></div>
      <div class="empty">条件に一致する商品がありません</div>`;
    return;
  }
  $("product-table-wrap").innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>${headers}</tr></thead>
        <tbody>
          ${items.map(p => {
            const isLow = p.stock === 0 && !p.discontinued;
            const isDisc = !!p.discontinued;
            return `
            <tr class="${isLow ? "low-stock" : ""} ${isDisc ? "discontinued" : ""}">
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
              <td>${esc(p.variation)}</td>
              <td>${skuLink(p.sku)}</td>
              <td>${esc(p.sale_start_date || "")}</td>
              <td style="text-align:right">${daysSince(p.sale_start_date)}</td>
              <td>${fmtPrice(p.cost_price)}</td>
              <td>${fmtPrice(p.selling_price)}</td>
              <td style="font-weight:600;color:${isLow ? "var(--red)" : "inherit"};cursor:pointer;text-decoration:underline dotted" title="クリックして編集" onclick="editStock(${p.id}, ${p.stock})">${fmt(p.stock)}</td>
              <td style="color:var(--blue);cursor:pointer;text-decoration:underline dotted" title="クリックして編集" onclick="editManualPending(${p.id}, ${pendingQtys[p.id] ?? 'null'})">${pendingQtys[p.id] ? fmt(pendingQtys[p.id]) : "−"}${p.manual_pending != null ? " ✎" : ""}</td>
              <td style="font-weight:700">${fmt((p.stock || 0) + (pendingQtys[p.id] || 0))}</td>
              <td>${fmt(p.reorder_point)}</td>
              <td style="font-weight:${calcOrderQty(p) > 0 ? "600" : "400"};color:${calcOrderQty(p) > 0 ? "var(--red)" : "var(--gray-400)"}">${calcOrderQty(p) > 0 ? fmt(calcOrderQty(p)) : "−"}</td>
              <td>${fmt(p.monthly_sales)}</td>
              <td>${fmt(p.sessions || 0)}</td>
              <td>${fmt(p.order_count || 0)}</td>
              <td style="text-align:center">${bulkRate(p)}</td>
              <td style="text-align:center">
                <button class="btn btn-sm ${isDisc ? "btn-primary" : "btn-secondary"}" onclick="toggleDiscontinued(${p.id})" style="font-size:11px;padding:3px 8px">
                  ${isDisc ? "終売" : "−"}
                </button>
              </td>
              <td><div class="actions">
                <button class="btn-icon" title="編集" onclick="openProductModal(${p.id})">✏️</button>
                <button class="btn-icon" title="削除" onclick="deleteProduct(${p.id}, '${esc(p.title)}')">🗑️</button>
              </div></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderPagination(total, current, size, cb) {
  const pages = Math.ceil(total / size);
  const countLabel = `<span style="color:var(--gray-500);font-size:12px">全${fmt(total)}件</span>`;
  if (pages <= 1) { $("product-pagination").innerHTML = countLabel; return; }
  let html = countLabel + " ";
  const start = Math.max(1, current - 2);
  const end = Math.min(pages, current + 2);
  if (start > 1) html += `<button class="page-btn" onclick="(${cb})(1)">1</button>${start > 2 ? '<span style="padding:0 4px">…</span>' : ""}`;
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === current ? "active" : ""}" onclick="(${cb})(${i})">${i}</button>`;
  }
  if (end < pages) html += `${end < pages - 1 ? '<span style="padding:0 4px">…</span>' : ""}<button class="page-btn" onclick="(${cb})(${pages})">${pages}</button>`;
  $("product-pagination").innerHTML = html;
}

let productSearchTimer;
$("product-search").addEventListener("input", e => {
  clearTimeout(productSearchTimer);
  productSearchTimer = setTimeout(() => {
    productSearch = e.target.value;
    productPage = 1;
    loadProducts();
  }, 300);
});

$("stock-filter").addEventListener("change", e => {
  productStockFilter = e.target.value;
  productPage = 1;
  loadProducts();
});

$("page-size").addEventListener("change", e => {
  pageSize = parseInt(e.target.value);
  productPage = 1;
  loadProducts();
});

$("btn-add-product").addEventListener("click", () => openProductModal(null));
$("btn-amazon-import").addEventListener("click", openAmazonImportModal);

$("btn-listing-import").addEventListener("click", openListingReportModal);

function openListingReportModal() {
  openModal("出品レポート取込", `
    <div style="display:flex;flex-direction:column;gap:20px">
      <div style="background:var(--blue-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">出品詳細レポート（.txt）</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          セラーセントラル → レポート → 出品レポート → 出品詳細レポート<br>
          <b>更新内容：</b>販売開始日（出品者SKUで既存商品と照合）
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".txt,.tsv" style="display:none" onchange="doListingReportImport(this)">
        </label>
        <div id="listing-report-result" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function doListingReportImport(input) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = $("listing-report-result");
  resultEl.textContent = "処理中...";
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/products/import-listing-report", { method: "POST", body: form });
    const data = await res.json();
    let html = `<span style="color:var(--green)">✓ 販売開始日を更新: ${data.updated}件</span>`;
    if (data.unmatched.length) html += `<br><span style="color:var(--red)">未照合SKU: ${data.unmatched.length}件（${data.unmatched.slice(0, 5).join(", ")}${data.unmatched.length > 5 ? " …" : ""}）</span>`;
    resultEl.innerHTML = html;
    loadProducts();
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`;
  }
  input.value = "";
}

$("btn-bulk-reorder").addEventListener("click", async () => {
  if (!confirm(`月間販売数 × リードタイム(${appSettings.lead_time_months}ヶ月) で発注点を一括更新します。よろしいですか？`)) return;
  try {
    const res = await api("POST", "/api/products/bulk-set-reorder-point");
    toast(`${res.updated}件の発注点を更新しました`);
    loadProducts();
    if (currentPage === "dashboard") loadDashboard();
  } catch (err) {
    toast("エラー: " + err.message, "error");
  }
});

function openAmazonImportModal() {
  openModal("Amazon CSVを取込", `
    <div style="display:flex;flex-direction:column;gap:20px">
      <div style="background:var(--blue-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">① FBA在庫管理CSV</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          セラーセントラル → レポート → フルフィルメント → 在庫管理<br>
          <b>更新内容：</b>在庫数・販売価格（SKUで既存商品と照合。未一致は新規作成）
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".csv" style="display:none" onchange="doAmazonImport(this,'fba')">
        </label>
        <div id="fba-result" style="margin-top:8px;font-size:12px"></div>
      </div>
      <div style="background:var(--green-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">② ビジネスレポート（詳細ページ 売上・トラフィック）</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          セラーセントラル → レポート → ビジネスレポート → 詳細ページ 売上・トラフィック<br>
          <b>更新内容：</b>月間販売数（SKUで既存商品と照合）
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".csv" style="display:none" onchange="doAmazonImport(this,'report')">
        </label>
        <div id="report-result" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function doAmazonImport(input, type) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = $(type === "fba" ? "fba-result" : "report-result");
  resultEl.textContent = "処理中...";

  const form = new FormData();
  form.append("file", file);
  const endpoint = type === "fba" ? "/api/import/amazon-fba" : "/api/import/amazon-report";

  try {
    const res = await fetch(endpoint, { method: "POST", body: form });
    const data = await res.json();
    if (type === "fba") {
      resultEl.innerHTML = `<span style="color:var(--green)">✓ 更新: ${data.updated}件 / 新規: ${data.created}件 / スキップ: ${data.skipped}件</span>`;
      if (data.errors.length) resultEl.innerHTML += `<br><span style="color:var(--red)">${data.errors.slice(0,3).join(", ")}</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:var(--green)">✓ 月間販売数・セッション数を更新: ${data.updated}件 / 未一致: ${data.skipped}件</span>`;
      if (data.errors.length) resultEl.innerHTML += `<br><span style="color:var(--red)">${data.errors.slice(0,3).join(", ")}</span>`;
    }
    loadProducts();
    if (currentPage === "dashboard") loadDashboard();
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`;
  }
  input.value = "";
}

$("csv-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/products/import-csv", { method: "POST", body: form });
    const data = await res.json();
    const msg = `更新: ${data.updated}件 / 新規: ${data.created}件${data.errors.length ? ` / エラー: ${data.errors.length}件` : ""}`;
    toast(msg, data.errors.length ? "error" : "success");
    loadProducts();
  } catch (err) {
    toast("インポートに失敗しました: " + err.message, "error");
  }
  e.target.value = "";
});

async function openProductModal(id) {
  let product = null;
  if (id) {
    product = await api("GET", `/api/products/${id}`);
  }
  const title = id ? "商品を編集" : "商品を追加";
  const v = product || {};

  openModal(title, `
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">商品タイトル *</label>
        <input class="input" id="f-title" value="${esc(v.title||"")}" required></div>
      <div class="form-group"><label class="form-label">バリエーション</label>
        <input class="input" id="f-variation" value="${esc(v.variation||"")}"></div>
      <div class="form-group"><label class="form-label">仕入れ工場</label>
        <input class="input" id="f-factory" value="${esc(v.factory||"")}"></div>
      <div class="form-group"><label class="form-label">仕入れ名</label>
        <input class="input" id="f-purchase_name" value="${esc(v.purchase_name||"")}"></div>
      <div class="form-group"><label class="form-label">衛進</label>
        <input class="input" id="f-eishin" value="${esc(v.eishin||"")}"></div>
      <div class="form-group"><label class="form-label">販売開始日</label>
        <input class="input" id="f-sale_start_date" type="date" value="${esc(v.sale_start_date||"")}"></div>
      <div class="form-group"><label class="form-label">SKU</label>
        <input class="input" id="f-sku" value="${esc(v.sku||"")}"></div>
      <div class="form-group"><label class="form-label">バーコード</label>
        <input class="input" id="f-barcode" value="${esc(v.barcode||"")}"></div>
      <div class="form-group full"><label class="form-label">Amazon URL</label>
        <input class="input" id="f-amazon_url" value="${esc(v.amazon_url||"")}"></div>
      <div class="form-group"><label class="form-label">仕入価格 (¥)</label>
        <input class="input" id="f-cost_price" type="number" min="0" value="${v.cost_price||0}"></div>
      <div class="form-group"><label class="form-label">販売価格 (¥)</label>
        <input class="input" id="f-selling_price" type="number" min="0" value="${v.selling_price||0}"></div>
      <div class="form-group"><label class="form-label">在庫数</label>
        <input class="input" id="f-stock" type="number" min="0" value="${v.stock||0}"></div>
      <div class="form-group"><label class="form-label">発注点</label>
        <input class="input" id="f-reorder_point" type="number" min="0" value="${v.reorder_point||0}"></div>
      <div class="form-group"><label class="form-label">月間販売数</label>
        <input class="input" id="f-monthly_sales" type="number" min="0" value="${v.monthly_sales||0}"></div>
      <div class="form-group"><label class="form-label">セッション数</label>
        <input class="input" id="f-sessions" type="number" min="0" value="${v.sessions != null ? v.sessions : 0}"></div>
      <div class="form-group"><label class="form-label">注文件数</label>
        <input class="input" id="f-order_count" type="number" min="0" value="${v.order_count != null ? v.order_count : 0}"></div>
      <div class="form-group full"><label class="form-label">メモ</label>
        <textarea class="input" id="f-notes">${esc(v.notes||"")}</textarea></div>
      <div class="form-group full">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="f-discontinued" ${v.discontinued ? "checked" : ""}>
          <span style="color:var(--red);font-weight:600">終売（発注提案から除外）</span>
        </label>
      </div>
    </div>
  `, async () => {
    const data = {
      title: $("f-title").value.trim(),
      variation: $("f-variation").value,
      factory: $("f-factory").value,
      purchase_name: $("f-purchase_name").value,
      eishin: $("f-eishin").value,
      sale_start_date: $("f-sale_start_date").value,
      sku: $("f-sku").value,
      barcode: $("f-barcode").value,
      amazon_url: $("f-amazon_url").value,
      cost_price: parseFloat($("f-cost_price").value) || 0,
      selling_price: parseFloat($("f-selling_price").value) || 0,
      stock: parseInt($("f-stock").value) || 0,
      reorder_point: parseInt($("f-reorder_point").value) || 0,
      monthly_sales: parseInt($("f-monthly_sales").value) || 0,
      sessions: parseInt($("f-sessions").value) || 0,
      order_count: parseInt($("f-order_count").value) || 0,
      notes: $("f-notes").value,
      discontinued: $("f-discontinued").checked ? 1 : 0,
    };
    if (!data.title) { toast("商品タイトルを入力してください", "error"); return false; }
    if (id) {
      await api("PUT", `/api/products/${id}`, data);
      toast("商品を更新しました");
    } else {
      await api("POST", "/api/products", data);
      toast("商品を追加しました");
    }
    loadProducts();
  });
}

async function toggleDiscontinued(id) {
  await api("PATCH", `/api/products/${id}/discontinued`);
  loadProducts();
  if (currentPage === "dashboard") loadDashboard();
  else if (currentPage === "orders") loadReorderSuggestions();
}

async function editStock(id, currentVal) {
  const input = prompt(`在庫数を入力してください`, String(currentVal));
  if (input === null) return;
  const value = parseInt(input.trim());
  if (isNaN(value) || value < 0) { toast("0以上の数値を入力してください", "error"); return; }
  await api("PATCH", `/api/products/${id}/stock`, { value });
  if (currentPage === "products") loadProducts();
  else if (currentPage === "dashboard") loadDashboard();
  else if (currentPage === "orders") loadReorderSuggestions();
  toast("在庫数を更新しました");
}

async function editManualPending(id, currentVal) {
  const input = prompt(
    `発注済み数を入力してください（空欄にすると自動計算に戻ります）`,
    currentVal != null ? String(currentVal) : ""
  );
  if (input === null) return; // キャンセル
  const value = input.trim() === "" ? null : parseInt(input.trim());
  if (value !== null && isNaN(value)) { toast("数値を入力してください", "error"); return; }
  await api("PATCH", `/api/products/${id}/manual-pending`, { value });
  await loadPendingQtys();
  if (currentPage === "products") loadProducts();
  else if (currentPage === "dashboard") loadDashboard();
  else if (currentPage === "orders") loadReorderSuggestions();
  toast("発注済み数を更新しました");
}

async function deleteProduct(id, name) {
  if (!confirm(`「${name}」を削除しますか？`)) return;
  await api("DELETE", `/api/products/${id}`);
  toast("削除しました");
  loadProducts();
}

// ---- Inventory ----

async function loadInventory() {
  const data = await api("GET", "/api/inventory?limit=200");
  if (data.length === 0) {
    $("transaction-table-wrap").innerHTML = `<div class="empty">記録がありません</div>`;
    return;
  }
  $("transaction-table-wrap").innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>日付</th><th>商品名</th><th>種別</th><th>数量</th><th>単価</th><th>メモ</th></tr></thead>
        <tbody>
          ${data.map(t => `
            <tr>
              <td>${t.date}</td>
              <td>${esc(t.product_title)}</td>
              <td><span class="badge ${t.type === "in" ? "badge-received" : "badge-cancelled"}">${t.type === "in" ? "入庫" : "出庫"}</span></td>
              <td>${fmt(t.quantity)}</td>
              <td>${t.unit_price ? fmtPrice(t.unit_price) : "-"}</td>
              <td>${esc(t.notes)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

$("btn-add-transaction").addEventListener("click", () => openTransactionModal());

async function openTransactionModal() {
  const products = await api("GET", "/api/products?limit=1000");
  openModal("入出庫を記録", `
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">商品 *</label>
        <select class="input" id="f-product_id">
          <option value="">-- 選択してください --</option>
          ${products.items.map(p => `<option value="${p.id}">${esc(p.title)}${p.variation ? " / " + esc(p.variation) : ""} (在庫:${p.stock})</option>`).join("")}
        </select></div>
      <div class="form-group"><label class="form-label">種別 *</label>
        <select class="input" id="f-type">
          <option value="in">入庫</option>
          <option value="out">出庫</option>
        </select></div>
      <div class="form-group"><label class="form-label">数量 *</label>
        <input class="input" id="f-quantity" type="number" min="1" value="1"></div>
      <div class="form-group"><label class="form-label">単価 (¥)</label>
        <input class="input" id="f-unit_price" type="number" min="0" value="0"></div>
      <div class="form-group"><label class="form-label">日付</label>
        <input class="input" id="f-date" type="date" value="${today()}"></div>
      <div class="form-group full"><label class="form-label">メモ</label>
        <input class="input" id="f-notes" value=""></div>
    </div>
  `, async () => {
    const data = {
      product_id: parseInt($("f-product_id").value),
      type: $("f-type").value,
      quantity: parseInt($("f-quantity").value) || 0,
      unit_price: parseFloat($("f-unit_price").value) || 0,
      date: $("f-date").value,
      notes: $("f-notes").value,
    };
    if (!data.product_id) { toast("商品を選択してください", "error"); return false; }
    if (data.quantity <= 0) { toast("数量を入力してください", "error"); return false; }
    await api("POST", "/api/inventory", data);
    toast("記録しました");
    loadInventory();
    if (currentPage === "dashboard") loadDashboard();
  });
}

// ---- Orders ----

let reorderSortBy = "_oq";
let reorderSortDir = "desc";
let reorderSearch = "";
let reorderAll = [];
let reorderHistory = {};  // SKU → [{date, qty}]  発注履歴
let reorderReceiptHistory = {}; // SKU → [{date, qty}]  受領履歴

function reorderSortIcon(key) {
  if (reorderSortBy !== key) return '<span style="color:var(--gray-300);margin-left:4px">⇅</span>';
  return reorderSortDir === "asc"
    ? '<span style="color:var(--blue);margin-left:4px">↑</span>'
    : '<span style="color:var(--blue);margin-left:4px">↓</span>';
}

function onReorderSort(key) {
  if (reorderSortBy === key) reorderSortDir = reorderSortDir === "asc" ? "desc" : "asc";
  else { reorderSortBy = key; reorderSortDir = "desc"; }
  renderReorderTable();
}

function toggleAllReorderChecks(checked) {
  document.querySelectorAll(".reorder-check").forEach(cb => cb.checked = checked);
}

async function bulkRegisterOrderPlan() {
  const date = $("bulk-order-date")?.value;
  if (!date) { toast("発注日を入力してください", "error"); return; }
  const checks = document.querySelectorAll(".reorder-check:checked");
  if (checks.length === 0) { toast("商品をチェックしてください", "error"); return; }
  const items = [];
  checks.forEach(cb => {
    const sku = cb.dataset.sku;
    const qty = parseInt(document.getElementById(cb.dataset.qtyId)?.value || "0");
    if (sku && qty > 0) items.push({ sku, quantity: qty });
  });
  if (items.length === 0) { toast("発注数が0の商品は登録できません", "error"); return; }
  await api("POST", "/api/order-plans/bulk", { plan_date: date, items });
  toast(`${items.length}件を発注プランに登録しました`);
  await loadReorderSuggestions();
  loadOrderPlans();
}

function toggleReorderHistory(id) {
  const row = document.getElementById(id);
  if (!row) return;
  row.style.display = row.style.display === "none" ? "" : "none";
}

function renderReorderTable() {
  const wrap = $("order-reorder-list");
  if (!wrap) return;

  const q = reorderSearch.toLowerCase();
  let items = reorderAll.filter(p =>
    !q || p.title.toLowerCase().includes(q) || (p.sku || p.nf_sku || "").toLowerCase().includes(q) || (p.variation || "").toLowerCase().includes(q)
  );

  items.sort((a, b) => {
    let av = a[reorderSortBy] ?? 0;
    let bv = b[reorderSortBy] ?? 0;
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return reorderSortDir === "asc" ? -1 : 1;
    if (av > bv) return reorderSortDir === "asc" ? 1 : -1;
    return 0;
  });

  if (items.length === 0) {
    wrap.innerHTML = `<div class="empty">発注が必要な商品はありません</div>`;
    return;
  }

  const thStyle = "cursor:pointer;user-select:none;white-space:nowrap";
  const COL_COUNT = 14;

  wrap.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <input type="text" class="input" placeholder="商品名・SKUで検索..." style="width:220px" value="${esc(reorderSearch)}" oninput="reorderSearch=this.value;renderReorderTable()">
      <label class="form-label" style="margin:0">発注日:</label>
      <input type="date" id="bulk-order-date" class="input" style="width:150px" value="${today()}">
      <button class="btn btn-primary" onclick="bulkRegisterOrderPlan()">チェックした商品を発注プランに登録</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="reorder-check-all" onchange="toggleAllReorderChecks(this.checked)"></th>
          <th style="width:28px"></th>
          <th style="${thStyle}" onclick="onReorderSort('title')">商品名${reorderSortIcon('title')}</th>
          <th style="${thStyle}" onclick="onReorderSort('variation')">バリエーション${reorderSortIcon('variation')}</th>
          <th>SKU</th>
          <th style="${thStyle}" onclick="onReorderSort('monthly_sales')">Amazon月販${reorderSortIcon('monthly_sales')}</th>
          <th style="${thStyle};color:#ff6900" onclick="onReorderSort('_rakuten_sales')">楽天月販${reorderSortIcon('_rakuten_sales')}</th>
          <th style="${thStyle};color:#6600cc" onclick="onReorderSort('yahoo_monthly_sales')">Yahoo月販${reorderSortIcon('yahoo_monthly_sales')}</th>
          <th style="${thStyle};color:#e63946" onclick="onReorderSort('selmon_sales_30d')">セルモン30日${reorderSortIcon('selmon_sales_30d')}</th>
          <th style="${thStyle}" onclick="onReorderSort('sessions')">セッション数${reorderSortIcon('sessions')}</th>
          <th style="${thStyle}" onclick="onReorderSort('stock')">在庫数${reorderSortIcon('stock')}</th>
          <th style="color:var(--blue)">発注済み</th>
          <th style="${thStyle};color:var(--red)" onclick="onReorderSort('_oq')">発注数${reorderSortIcon('_oq')}</th>
          <th>発注数入力</th>
        </tr></thead>
        <tbody>
          ${items.map((p, idx) => {
            const sku = p.sku || p.nf_sku || "";
            const hist = reorderHistory[sku] || [];
            const recHist = reorderReceiptHistory[sku] || [];
            const histId = `rh-${idx}`;
            const noData = hist.length === 0 && recHist.length === 0;

            function miniTable(rows, label, color) {
              if (rows.length === 0) return `<div style="color:var(--gray-300);font-size:11px">${label}なし</div>`;
              return `
                <div style="font-size:11px;font-weight:700;color:${color};margin-bottom:2px">${label}</div>
                <table style="font-size:12px;border-collapse:collapse">
                  <tbody>${rows.map(h => `<tr><td style="padding:1px 12px 1px 0;white-space:nowrap">${h.date}</td><td style="padding:1px 0;text-align:right;font-weight:600">${fmt(h.qty)}</td></tr>`).join("")}</tbody>
                </table>`;
            }

            const histHtml = noData
              ? `<tr id="${histId}" style="display:none"><td colspan="${COL_COUNT}" style="padding:6px 16px;background:var(--gray-50);color:var(--gray-500);font-size:12px">履歴なし</td></tr>`
              : `<tr id="${histId}" style="display:none"><td colspan="${COL_COUNT}" style="padding:8px 16px 10px;background:var(--gray-50)">
                  <div style="display:flex;gap:32px">
                    <div>${miniTable(hist, "発注履歴", "var(--blue)")}</div>
                    <div>${miniTable(recHist, "受領履歴", "var(--green)")}</div>
                  </div>
                </td></tr>`;
            return `
            <tr class="${p.stock === 0 ? "low-stock" : ""}">
              <td style="text-align:center"><input type="checkbox" class="reorder-check" data-sku="${esc(sku)}" data-qty-id="rqty-${idx}"></td>
              <td style="text-align:center">
                <button class="btn-icon" style="font-size:11px;padding:2px 4px" onclick="toggleReorderHistory('${histId}')" title="発注・受領履歴">${!noData ? "▶" : "−"}</button>
              </td>
              <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
              <td>${esc(p.variation)}</td>
              <td>${skuLink(sku)}</td>
              <td>${fmt(p.monthly_sales)}</td>
              <td style="color:#ff6900">${p._rakuten_sales > 0 ? fmt(p._rakuten_sales) : "−"}</td>
              <td style="color:#6600cc">${p.yahoo_monthly_sales > 0 ? fmt(p.yahoo_monthly_sales) : "−"}</td>
              <td style="color:#e63946">${p.selmon_sales_30d > 0 ? fmt(p.selmon_sales_30d) : "−"}</td>
              <td>${fmt(p.sessions || 0)}</td>
              <td style="font-weight:600;cursor:pointer;text-decoration:underline dotted" title="クリックして編集" onclick="editStock(${p.id}, ${p.stock})">${fmt(p.stock)}</td>
              <td style="color:var(--blue);cursor:pointer;text-decoration:underline dotted" title="クリックして編集" onclick="editManualPending(${p.id}, ${pendingQtys[p.id] ?? 'null'})">${pendingQtys[p.id] ? fmt(pendingQtys[p.id]) : "−"}${p.manual_pending != null ? " ✎" : ""}</td>
              <td style="font-weight:700;color:var(--red)">${fmt(p._oq)}</td>
              <td style="white-space:nowrap">
                <input type="number" id="rqty-${idx}" class="input" min="0" value="${p._oq}" style="width:70px;padding:4px 6px">
                ${sku ? `<a href="https://1688japan.com/member/order-list?products=%5B%5D&keyword=${encodeURIComponent(sku)}" target="_blank" rel="noopener" style="margin-left:8px;font-size:12px;color:var(--blue)">1688↗</a>` : ""}
              </td>
            </tr>
            ${histHtml}`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

async function loadReorderSuggestions() {
  const lbl = $("order-reorder-settings-label");
  if (lbl) lbl.textContent = settingsLabel();

  const [allProducts, historyData, receiptData, rakutenSales] = await Promise.all([
    api("GET", "/api/products?limit=9999"),
    api("GET", "/api/order-plans/history"),
    api("GET", "/api/receipts/history"),
    api("GET", "/api/rakuten/monthly-sales-summary"),
  ]);

  reorderHistory = {};
  historyData.forEach(r => {
    if (!reorderHistory[r.sku]) reorderHistory[r.sku] = [];
    reorderHistory[r.sku].push({ date: r.plan_date, qty: r.quantity });
  });

  reorderReceiptHistory = {};
  receiptData.forEach(r => {
    if (!reorderReceiptHistory[r.sku]) reorderReceiptHistory[r.sku] = [];
    reorderReceiptHistory[r.sku].push({ date: r.receipt_date, qty: r.quantity });
  });

  reorderAll = allProducts.items
    .map(p => ({ ...p,
      _oq: calcOrderQty(p),
      _rp: calcReorderPoint(p),
      _rakuten_sales: rakutenSales[String(p.id)] || 0,
    }))
    .filter(p => p._oq > 0);

  renderReorderTable();
}

async function loadOrders() {
  await loadPendingQtys();
  loadReorderSuggestions();
  loadOrderPlans();
  const status = $("order-status-filter").value;
  const data = await api("GET", `/api/orders?status=${status}`);
  if (data.length === 0) {
    $("order-table-wrap").innerHTML = `<div class="empty">発注がありません</div>`;
    return;
  }
  const statusLabel = { pending: "未発注", ordered: "発注済", received: "受領済", cancelled: "キャンセル" };
  $("order-table-wrap").innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>発注日</th><th>商品名</th><th>仕入先</th><th>数量</th><th>単価</th><th>納期予定</th><th>ステータス</th><th></th></tr></thead>
        <tbody>
          ${data.map(o => `
            <tr>
              <td>${o.order_date}</td>
              <td>${esc(o.product_title)}</td>
              <td>${esc(o.supplier_name || "-")}</td>
              <td>${fmt(o.quantity)}</td>
              <td>${o.unit_price ? fmtPrice(o.unit_price) : "-"}</td>
              <td>${o.expected_delivery || "-"}</td>
              <td><span class="badge badge-${o.status}">${statusLabel[o.status] || o.status}</span></td>
              <td><div class="actions">
                ${o.status !== "received" && o.status !== "cancelled" ? `
                  <button class="btn btn-sm btn-primary" onclick="updateOrderStatus(${o.id}, 'received')">受領</button>
                  <button class="btn btn-sm btn-secondary" onclick="updateOrderStatus(${o.id}, 'ordered')">発注済</button>
                ` : ""}
                <button class="btn-icon" onclick="deleteOrder(${o.id})">🗑️</button>
              </div></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

$("order-status-filter").addEventListener("change", loadOrders);
$("btn-add-order").addEventListener("click", () => openOrderModal(null));

async function openOrderModal(productId) {
  const [products, suppliers] = await Promise.all([
    api("GET", "/api/products?limit=1000"),
    api("GET", "/api/suppliers"),
  ]);
  const productMap = {};
  products.items.forEach(p => { productMap[p.id] = p; });

  function build1688Link(pid) {
    const p = productMap[pid];
    const sku = p ? (p.sku || p.nf_sku) : "";
    if (!sku) return `<span style="color:var(--gray-300)">商品を選択するとリンクが表示されます</span>`;
    const url = `https://1688japan.com/member/order-list?products=%5B%5D&keyword=${encodeURIComponent(sku)}`;
    return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--blue);font-weight:600">1688japan で「${esc(sku)}」を検索 →</a>`;
  }

  openModal("発注を追加", `
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">商品 *</label>
        <select class="input" id="f-product_id">
          <option value="">-- 選択 --</option>
          ${products.items.map(p => `<option value="${p.id}" ${p.id === productId ? "selected" : ""}>${esc(p.title)}${p.variation ? " / " + esc(p.variation) : ""} (在庫:${p.stock})</option>`).join("")}
        </select></div>
      <div class="form-group full"><label class="form-label">仕入先</label>
        <select class="input" id="f-supplier_id">
          <option value="">-- 選択 --</option>
          ${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
        </select>
        <div id="f-1688link" style="margin-top:6px;font-size:13px">${build1688Link(productId)}</div>
      </div>
      <div class="form-group"><label class="form-label">発注数量 *</label>
        <input class="input" id="f-quantity" type="number" min="1" value="1"></div>
      <div class="form-group"><label class="form-label">仕入単価 (¥)</label>
        <input class="input" id="f-unit_price" type="number" min="0" value="0"></div>
      <div class="form-group"><label class="form-label">発注日</label>
        <input class="input" id="f-order_date" type="date" value="${today()}"></div>
      <div class="form-group"><label class="form-label">納期予定</label>
        <input class="input" id="f-expected_delivery" type="date"></div>
      <div class="form-group full"><label class="form-label">メモ</label>
        <input class="input" id="f-notes" value=""></div>
    </div>
  `, async () => {
    const data = {
      product_id: parseInt($("f-product_id").value),
      supplier_id: parseInt($("f-supplier_id").value) || null,
      quantity: parseInt($("f-quantity").value) || 0,
      unit_price: parseFloat($("f-unit_price").value) || 0,
      order_date: $("f-order_date").value,
      expected_delivery: $("f-expected_delivery").value,
      notes: $("f-notes").value,
    };
    if (!data.product_id) { toast("商品を選択してください", "error"); return false; }
    if (data.quantity <= 0) { toast("発注数量を入力してください", "error"); return false; }
    await api("POST", "/api/orders", data);
    toast("発注を追加しました");
    loadOrders();
    if (currentPage === "dashboard") loadDashboard();
  });
  // 商品切替時にリンクを更新
  const sel = $("f-product_id");
  if (sel) sel.addEventListener("change", () => {
    const lnk = $("f-1688link");
    if (lnk) lnk.innerHTML = build1688Link(parseInt(sel.value) || null);
  });
}

async function updateOrderStatus(id, status) {
  await api("PUT", `/api/orders/${id}/status`, { status });
  toast(status === "received" ? "受領処理完了（在庫に反映しました）" : "ステータスを更新しました");
  loadOrders();
  if (currentPage === "dashboard") loadDashboard();
}

async function deleteOrder(id) {
  if (!confirm("この発注を削除しますか？")) return;
  await api("DELETE", `/api/orders/${id}`);
  toast("削除しました");
  loadOrders();
}

// ---- Order Plans & Receipts ----

function switchOrderTab(tab) {
  const isOrders = tab === "orders";
  $("orders-tab-content").style.display = isOrders ? "" : "none";
  $("receipts-tab-content").style.display = isOrders ? "none" : "";
  $("tab-btn-orders").classList.toggle("active", isOrders);
  $("tab-btn-receipts").classList.toggle("active", !isOrders);
  if (isOrders) {
    loadPendingQtys().then(() => loadReorderSuggestions());
    loadOrderPlans();
  } else {
    loadReceipts();
  }
}

let cachedOrderPlans = [];

async function loadOrderPlans() {
  try { cachedOrderPlans = await api("GET", "/api/order-plans"); } catch(e) { return; }
  const wrap = $("order-plans-wrap");
  if (!wrap) return;
  if (cachedOrderPlans.length === 0) {
    wrap.innerHTML = `<div class="empty" style="padding:24px">発注プランがありません</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>発注日</th><th>商品数</th><th>合計発注数</th><th>備考</th><th></th></tr></thead>
        <tbody>
          ${cachedOrderPlans.map(plan => {
            const totalQty = plan.items.reduce((s, i) => s + i.quantity, 0);
            return `<tr>
              <td>${plan.plan_date}</td>
              <td>${plan.items.length}品</td>
              <td>${fmt(totalQty)}</td>
              <td>${esc(plan.notes)}</td>
              <td><div class="actions">
                <button class="btn btn-sm btn-secondary" onclick="viewPlanDetail(${plan.id})">詳細</button>
                <button class="btn-icon" onclick="deleteOrderPlan(${plan.id})">🗑️</button>
              </div></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function viewPlanDetail(planId) {
  const plan = cachedOrderPlans.find(p => p.id === planId);
  if (!plan) return;
  openModal(`発注プラン詳細 (${plan.plan_date})`, `
    <div class="table-wrap">
      <table>
        <thead><tr><th>SKU</th><th>商品名</th><th>発注数</th></tr></thead>
        <tbody>
          ${plan.items.map(item => `<tr>
            <td>${esc(item.sku)}</td>
            <td>${esc(item.product_title || "（未登録）")}${item.variation ? " / " + esc(item.variation) : ""}</td>
            <td style="font-weight:600">${fmt(item.quantity)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function deleteOrderPlan(planId) {
  if (!confirm("この発注プランを削除しますか？\n（発注数が未発注として計算に反映されなくなります）")) return;
  await api("DELETE", `/api/order-plans/${planId}`);
  toast("削除しました");
  await loadPendingQtys();
  loadOrderPlans();
  loadReorderSuggestions();
  if (currentPage === "dashboard") loadDashboard();
}

function openOrderPlanImportModal() {
  openModal("発注プランをCSVインポート", `
    <div class="form-grid">
      <div class="form-group full">
        <label class="form-label">発注日 *</label>
        <input class="input" id="f-plan-date" type="date" value="${today()}" style="width:180px">
      </div>
      <div class="form-group full">
        <label class="form-label">備考</label>
        <input class="input" id="f-plan-notes" value="" placeholder="任意">
      </div>
      <div class="form-group full">
        <label class="form-label">CSVファイル（SKU・発注数の2列） *</label>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択
          <input type="file" id="f-plan-file" accept=".csv" style="display:none">
        </label>
        <span id="f-plan-filename" style="margin-left:8px;font-size:12px;color:var(--gray-500)">未選択</span>
      </div>
    </div>
  `, async () => {
    const date = $("f-plan-date").value;
    const file = $("f-plan-file").files[0];
    const notes = $("f-plan-notes").value;
    if (!date) { toast("発注日を入力してください", "error"); return false; }
    if (!file) { toast("CSVファイルを選択してください", "error"); return false; }
    const form = new FormData();
    form.append("plan_date", date);
    form.append("notes", notes);
    form.append("file", file);
    const res = await fetch("/api/order-plans/import", { method: "POST", body: form });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "インポート失敗"); }
    const data = await res.json();
    const warnPart = data.not_found > 0 ? ` / SKU未登録:${data.not_found}件` : "";
    toast(`${data.imported}件の発注を登録しました${warnPart}`);
    await loadPendingQtys();
    loadOrderPlans();
    loadReorderSuggestions();
    if (currentPage === "dashboard") loadDashboard();
  });
  $("f-plan-file").addEventListener("change", e => {
    $("f-plan-filename").textContent = e.target.files[0]?.name || "未選択";
  });
}

let cachedReceipts = [];

async function loadReceipts() {
  try { cachedReceipts = await api("GET", "/api/receipts"); } catch(e) { return; }
  const wrap = $("receipts-wrap");
  if (!wrap) return;
  if (cachedReceipts.length === 0) {
    wrap.innerHTML = `<div class="empty" style="padding:24px">受領記録がありません</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>受領日</th><th>商品数</th><th>合計受領数</th><th>備考</th><th></th></tr></thead>
        <tbody>
          ${cachedReceipts.map(r => {
            const totalQty = r.items.reduce((s, i) => s + i.quantity, 0);
            return `<tr>
              <td>${r.receipt_date}</td>
              <td>${r.items.length}品</td>
              <td>${fmt(totalQty)}</td>
              <td>${esc(r.notes)}</td>
              <td><div class="actions">
                <button class="btn btn-sm btn-secondary" onclick="viewReceiptDetail(${r.id})">詳細</button>
                <button class="btn-icon" onclick="deleteReceipt(${r.id})">🗑️</button>
              </div></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function viewReceiptDetail(receiptId) {
  const r = cachedReceipts.find(r => r.id === receiptId);
  if (!r) return;
  openModal(`受領詳細 (${r.receipt_date})`, `
    <div class="table-wrap">
      <table>
        <thead><tr><th>SKU</th><th>商品名</th><th>受領数</th></tr></thead>
        <tbody>
          ${r.items.map(item => `<tr>
            <td>${esc(item.sku)}</td>
            <td>${esc(item.product_title || "（未登録）")}${item.variation ? " / " + esc(item.variation) : ""}</td>
            <td style="font-weight:600">${fmt(item.quantity)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function deleteReceipt(receiptId) {
  if (!confirm("この受領記録を削除しますか？\n（発注中数量の計算に反映されます）")) return;
  await api("DELETE", `/api/receipts/${receiptId}`);
  toast("削除しました");
  await loadPendingQtys();
  loadReceipts();
  loadReorderSuggestions();
  if (currentPage === "dashboard") loadDashboard();
}

function openReceiptImportModal() {
  openModal("受領をCSVインポート", `
    <div class="form-grid">
      <div class="form-group full">
        <label class="form-label">受領日 *</label>
        <input class="input" id="f-receipt-date" type="date" value="${today()}" style="width:180px">
      </div>
      <div class="form-group full">
        <label class="form-label">備考</label>
        <input class="input" id="f-receipt-notes" value="" placeholder="任意">
      </div>
      <div class="form-group full">
        <label class="form-label">CSVファイル（SKU(数量) 形式） *</label>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択
          <input type="file" id="f-receipt-file" accept=".csv" style="display:none">
        </label>
        <span id="f-receipt-filename" style="margin-left:8px;font-size:12px;color:var(--gray-500)">未選択</span>
        <div style="margin-top:6px;font-size:12px;color:var(--gray-500)">例: AY130-2(6)</div>
      </div>
    </div>
  `, async () => {
    const date = $("f-receipt-date").value;
    const file = $("f-receipt-file").files[0];
    const notes = $("f-receipt-notes").value;
    if (!date) { toast("受領日を入力してください", "error"); return false; }
    if (!file) { toast("CSVファイルを選択してください", "error"); return false; }
    const form = new FormData();
    form.append("receipt_date", date);
    form.append("notes", notes);
    form.append("file", file);
    const res = await fetch("/api/receipts/import", { method: "POST", body: form });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "インポート失敗"); }
    const data = await res.json();
    const warnPart = data.not_found > 0 ? ` / SKU未登録:${data.not_found}件` : "";
    toast(`${data.imported}件を受領登録しました（発注中数量を更新）${warnPart}`);
    await loadPendingQtys();
    loadReceipts();
    loadProducts();
    loadReorderSuggestions();
    if (currentPage === "dashboard") loadDashboard();
  });
  $("f-receipt-file").addEventListener("change", e => {
    $("f-receipt-filename").textContent = e.target.files[0]?.name || "未選択";
  });
}

$("btn-import-order-plan").addEventListener("click", openOrderPlanImportModal);
$("btn-import-receipt").addEventListener("click", openReceiptImportModal);

$("btn-dl-order-template").addEventListener("click", () => {
  csvDownload("SKU,発注数\nABC-001,100\nABC-002,50\n", "発注テンプレート.csv");
});

$("btn-dl-receipt-template").addEventListener("click", () => {
  csvDownload("品番数量\nAY130-2(6)\nAY037-3(2)\n", "受領テンプレート.csv");
});

function csvDownload(content, filename) {
  const blob = new Blob(["﻿" + content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Suppliers ----

async function loadSuppliers() {
  const data = await api("GET", "/api/suppliers");
  if (data.length === 0) {
    $("supplier-table-wrap").innerHTML = `<div class="empty">仕入先がありません</div>`;
    return;
  }
  $("supplier-table-wrap").innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>仕入先名</th><th>担当者</th><th>電話</th><th>メール</th><th>住所</th><th></th></tr></thead>
        <tbody>
          ${data.map(s => `
            <tr>
              <td><strong>${esc(s.name)}</strong></td>
              <td>${esc(s.contact_person)}</td>
              <td>${esc(s.phone)}</td>
              <td>${esc(s.email)}</td>
              <td>${esc(s.address)}</td>
              <td><div class="actions">
                <button class="btn-icon" onclick="openSupplierModal(${s.id})">✏️</button>
                <button class="btn-icon" onclick="deleteSupplier(${s.id}, '${esc(s.name)}')">🗑️</button>
              </div></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

$("btn-add-supplier").addEventListener("click", () => openSupplierModal(null));

async function openSupplierModal(id) {
  let supplier = null;
  if (id) {
    const all = await api("GET", "/api/suppliers");
    supplier = all.find(s => s.id === id) || null;
  }
  const v = supplier || {};
  openModal(id ? "仕入先を編集" : "仕入先を追加", `
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">仕入先名 *</label>
        <input class="input" id="f-name" value="${esc(v.name||"")}"></div>
      <div class="form-group"><label class="form-label">担当者</label>
        <input class="input" id="f-contact_person" value="${esc(v.contact_person||"")}"></div>
      <div class="form-group"><label class="form-label">電話</label>
        <input class="input" id="f-phone" value="${esc(v.phone||"")}"></div>
      <div class="form-group full"><label class="form-label">メール</label>
        <input class="input" id="f-email" value="${esc(v.email||"")}"></div>
      <div class="form-group full"><label class="form-label">住所</label>
        <input class="input" id="f-address" value="${esc(v.address||"")}"></div>
      <div class="form-group full"><label class="form-label">メモ</label>
        <textarea class="input" id="f-notes">${esc(v.notes||"")}</textarea></div>
    </div>
  `, async () => {
    const data = {
      name: $("f-name").value.trim(),
      contact_person: $("f-contact_person").value,
      phone: $("f-phone").value,
      email: $("f-email").value,
      address: $("f-address").value,
      notes: $("f-notes").value,
    };
    if (!data.name) { toast("仕入先名を入力してください", "error"); return false; }
    if (id) {
      await api("PUT", `/api/suppliers/${id}`, data);
      toast("仕入先を更新しました");
    } else {
      await api("POST", "/api/suppliers", data);
      toast("仕入先を追加しました");
    }
    loadSuppliers();
  });
}

async function deleteSupplier(id, name) {
  if (!confirm(`「${name}」を削除しますか？`)) return;
  await api("DELETE", `/api/suppliers/${id}`);
  toast("削除しました");
  loadSuppliers();
}

// ---- Modal ----

let modalSaveCallback = null;

function openModal(title, bodyHtml, onSave) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  $("modal-overlay").classList.remove("hidden");
  modalSaveCallback = onSave;
}

function closeModal() {
  $("modal-overlay").classList.add("hidden");
  $("modal-save").style.display = "";
  $("modal-cancel").textContent = "キャンセル";
  modalSaveCallback = null;
}

$("modal-close").addEventListener("click", closeModal);
$("modal-cancel").addEventListener("click", closeModal);
$("modal-overlay").addEventListener("click", e => { if (e.target === $("modal-overlay")) closeModal(); });

$("modal-save").addEventListener("click", async () => {
  if (!modalSaveCallback) return;
  try {
    const result = await modalSaveCallback();
    if (result !== false) closeModal();
  } catch (err) {
    toast(err.message || "エラーが発生しました", "error");
  }
});

// ---- Helpers ----

function today() {
  return new Date().toISOString().slice(0, 10);
}

function bulkRate(p) {
  if (!p.order_count || p.order_count === 0) return "-";
  const rate = p.monthly_sales / p.order_count;
  const color = rate >= 2 ? "var(--blue)" : rate >= 1.5 ? "var(--green)" : "inherit";
  return `<span style="font-weight:600;color:${color}">${rate.toFixed(1)}</span>`;
}

function esc(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---- Channel Stock ----

const CHANNELS = {
  amazon:  { label: "Amazon",  field: "amazon_stock",  color: "#ff9900" },
  yahoo:   { label: "Yahoo",   field: "yahoo_stock",   color: "#e60012" },
  rakuten: { label: "楽天",    field: "rakuten_stock", color: "#bf0000" },
  mercari: { label: "メルカリ", field: "mercari_stock", color: "#ff0211" },
};

let chSearchTimer = {};

async function loadChannelPage(ch) {
  const search = ($(`ch-${ch}-search`) || {}).value || "";
  const data = await api("GET", `/api/products?limit=9999&search=${encodeURIComponent(search)}`);
  const wrap = $(`ch-${ch}-table`);
  if (!wrap) return;

  if (data.items.length === 0) {
    wrap.innerHTML = `<div class="empty">商品がありません</div>`;
    return;
  }

  const chList = Object.entries(CHANNELS);
  const headers = chList.map(([k, c]) =>
    `<th style="color:${c.color};text-align:center">${c.label}</th>`
  ).join("");

  const rows = data.items.map(p => {
    const cells = chList.map(([k, c]) => {
      const val = p[c.field] || 0;
      const bold = k === ch ? `font-weight:700;color:${c.color}` : "";
      return `<td style="text-align:center;${bold}">${fmt(val)}</td>`;
    }).join("");
    return `
      <tr>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
        <td>${esc(p.variation)}</td>
        <td>${skuLink(p.sku || p.nf_sku)}</td>
        ${cells}
        <td><button class="btn btn-sm btn-secondary" onclick="openChannelStockModal(${p.id})">編集</button></td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>商品名</th><th>バリエーション</th><th>SKU</th>
          ${headers}
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // 検索ボックスのイベントを設定
  const searchEl = $(`ch-${ch}-search`);
  if (searchEl && !searchEl._bound) {
    searchEl._bound = true;
    searchEl.addEventListener("input", e => {
      clearTimeout(chSearchTimer[ch]);
      chSearchTimer[ch] = setTimeout(() => loadChannelPage(ch), 300);
    });
  }
}

async function openChannelStockModal(id) {
  const p = await api("GET", `/api/products/${id}`);
  openModal("チャネル別在庫編集", `
    <div style="margin-bottom:8px;font-weight:600">${esc(p.title)}${p.variation ? " / " + esc(p.variation) : ""}</div>
    <div class="form-grid">
      ${Object.entries(CHANNELS).map(([k, c]) => `
        <div class="form-group">
          <label class="form-label" style="color:${c.color};font-weight:700">${c.label}</label>
          <input class="input" id="fch-${k}" type="number" min="0" value="${p[c.field] || 0}">
        </div>`).join("")}
    </div>
  `, async () => {
    const body = {};
    Object.keys(CHANNELS).forEach(k => {
      body[`${k}_stock`] = parseInt($(`fch-${k}`).value) || 0;
    });
    await api("PATCH", `/api/products/${id}/channel-stock`, body);
    toast("チャネル在庫を更新しました");
    const ch = currentPage.startsWith("ch-") ? currentPage.slice(3) : null;
    if (ch) loadChannelPage(ch);
  });
}

// ---- Settings Modal ----

function openSettingsModal() {
  openModal("発注設定", `
    <div class="form-grid">
      <div class="form-group full">
        <label class="form-label">リードタイム（発注〜入荷までの月数）</label>
        <input class="input" id="f-lead_time" type="number" min="0.5" max="12" step="0.5" value="${appSettings.lead_time_months}" style="width:120px">
        <div style="font-size:12px;color:var(--gray-500);margin-top:6px">
          発注点 = 月間販売数 × リードタイム<br>
          発注数 = 発注点 − 現在の在庫数
        </div>
      </div>
    </div>
  `, async () => {
    const lead = parseFloat($("f-lead_time").value);
    if (!lead || lead <= 0) { toast("リードタイムを入力してください", "error"); return false; }
    await api("PUT", "/api/settings", { lead_time_months: lead, target_stock_months: lead });
    appSettings.lead_time_months = lead;
    appSettings.target_stock_months = lead;
    toast("設定を保存しました");
    if (currentPage === "dashboard") loadDashboard();
    else if (currentPage === "orders") loadOrders();
    else if (currentPage === "products") loadProducts();
  });
}

document.getElementById("btn-settings").addEventListener("click", e => {
  e.preventDefault();
  openSettingsModal();
});

// ---- Rakuten Dashboard ----

async function loadRakutenDashboard() {
  const [summary, lowStock, recentOrders] = await Promise.all([
    api("GET", "/api/rakuten/dashboard"),
    api("GET", "/api/rakuten/products?rakuten_only=true&limit=9999"),
    api("GET", "/api/rakuten/orders?limit=10"),
  ]);

  $("r-stat-grid").innerHTML = `
    <div class="stat-card"><div class="label">楽天出品商品数</div><div class="value">${fmt(summary.total_products)}</div></div>
    <div class="stat-card warning"><div class="label">在庫不足</div><div class="value">${fmt(summary.low_stock_count)}</div></div>
    <div class="stat-card info"><div class="label">今月受注数</div><div class="value">${fmt(summary.monthly_order_qty)}</div></div>
    <div class="stat-card"><div class="label">今月売上</div><div class="value" style="font-size:20px">${fmtPrice(summary.monthly_sales)}</div></div>
  `;

  const lowItems = lowStock.items.filter(p => {
    const ms = p.rakuten_monthly_sales || 0;
    const rp = Math.ceil(ms * appSettings.lead_time_months);
    return p.rakuten_stock === 0 || (rp > 0 && p.rakuten_stock < rp);
  });
  if (lowItems.length === 0) {
    $("r-low-stock-list").innerHTML = `<div class="empty">在庫不足の楽天商品はありません</div>`;
  } else {
    $("r-low-stock-list").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>商品名</th><th>バリエーション</th><th>楽天番号</th><th>楽天月販(30日)</th><th>楽天在庫</th><th>楽天発注点</th></tr></thead>
        <tbody>${lowItems.map(p => {
          const ms = p.rakuten_monthly_sales || 0;
          const rp = Math.ceil(ms * appSettings.lead_time_months);
          return `
          <tr class="${p.rakuten_stock === 0 ? "low-stock" : ""}">
            <td>${esc(p.title)}</td><td>${esc(p.variation)}</td>
            <td>${esc(p.rakuten_item_number)}</td>
            <td>${fmt(ms)}</td>
            <td style="color:var(--red);font-weight:700">${fmt(p.rakuten_stock)}</td>
            <td>${rp > 0 ? fmt(rp) : "−"}</td>
          </tr>`;
        }).join("")}
        </tbody>
      </table></div>`;
  }

  if (recentOrders.items.length === 0) {
    $("r-recent-orders").innerHTML = `<div class="empty">受注データがありません（受注CSVをインポートしてください）</div>`;
  } else {
    $("r-recent-orders").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>注文日</th><th>注文番号</th><th>商品名</th><th>個数</th><th>金額</th></tr></thead>
        <tbody>${recentOrders.items.map(o => `
          <tr>
            <td>${o.order_date}</td>
            <td style="font-size:12px">${esc(o.order_number)}</td>
            <td>${esc(o.product_title || o.item_name)}</td>
            <td>${fmt(o.quantity)}</td>
            <td>${fmtPrice(o.total_price)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  }
}

// ---- Rakuten Products ----

let rProductPage = 1;
let rPageSize = 100;
let rProductSearch = "";
let rRakutenOnly = false;
let rSortBy = "title";
let rSortDir = "asc";
let rSearchTimer;

function rSortIcon(key) {
  if (rSortBy !== key) return '<span style="color:var(--gray-300);margin-left:4px">⇅</span>';
  return rSortDir === "asc"
    ? '<span style="color:var(--blue);margin-left:4px">↑</span>'
    : '<span style="color:var(--blue);margin-left:4px">↓</span>';
}

function onRSortClick(key) {
  if (rSortBy === key) rSortDir = rSortDir === "asc" ? "desc" : "asc";
  else { rSortBy = key; rSortDir = "asc"; }
  rProductPage = 1;
  loadRakutenProducts();
}

async function loadRakutenProducts() {
  const limit = rPageSize;
  const offset = (rProductPage - 1) * rPageSize;
  const params = new URLSearchParams({
    search: rProductSearch,
    rakuten_only: rRakutenOnly ? "true" : "false",
    sort_by: rSortBy,
    sort_dir: rSortDir,
    limit,
    offset,
  });
  const data = await api("GET", `/api/rakuten/products?${params}`);
  renderRakutenProductTable(data.items);
  renderRakutenPagination(data.total);
}

function calcRakutenReorderPoint(p) {
  return Math.ceil((p.rakuten_monthly_sales || 0) * appSettings.lead_time_months);
}

function renderRakutenProductTable(items) {
  if (items.length === 0) {
    $("r-product-table-wrap").innerHTML = `<div class="empty">条件に一致する商品がありません</div>`;
    return;
  }
  const thS = "cursor:pointer;user-select:none;white-space:nowrap";
  $("r-product-table-wrap").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th style="${thS}" onclick="onRSortClick('title')">商品名${rSortIcon('title')}</th>
        <th style="${thS}" onclick="onRSortClick('variation')">バリエーション${rSortIcon('variation')}</th>
        <th style="${thS}" onclick="onRSortClick('sku')">SKU${rSortIcon('sku')}</th>
        <th style="${thS}" onclick="onRSortClick('rakuten_item_number')">楽天商品番号${rSortIcon('rakuten_item_number')}</th>
        <th style="${thS}" onclick="onRSortClick('rakuten_stock')">楽天在庫${rSortIcon('rakuten_stock')}</th>
        <th style="${thS}" onclick="onRSortClick('rakuten_price')">楽天価格${rSortIcon('rakuten_price')}</th>
        <th style="${thS}" onclick="onRSortClick('rakuten_monthly_sales')" title="過去30日の受注合計">楽天月販(30日)${rSortIcon('rakuten_monthly_sales')}</th>
        <th title="楽天月販 × リードタイム">楽天発注点</th><th></th>
      </tr></thead>
      <tbody>${items.map(p => {
        const rp = calcRakutenReorderPoint(p);
        const ms = p.rakuten_monthly_sales || 0;
        const isLow = p.rakuten_item_number && rp > 0 && p.rakuten_stock < rp;
        return `
        <tr class="${isLow && p.rakuten_stock === 0 ? "low-stock" : ""}">
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
          <td>${esc(p.variation)}</td>
          <td>${esc(p.sku || p.nf_sku)}</td>
          <td style="color:${p.rakuten_item_number ? "inherit" : "var(--gray-300)"}">${esc(p.rakuten_item_number) || "未設定"}</td>
          <td style="font-weight:600;color:${isLow ? "var(--red)" : "inherit"}">${fmt(p.rakuten_stock)}</td>
          <td>${p.rakuten_price ? fmtPrice(p.rakuten_price) : "−"}</td>
          <td style="color:${ms > 0 ? "inherit" : "var(--gray-300)"}">${ms > 0 ? fmt(ms) : "−"}</td>
          <td>${rp > 0 ? fmt(rp) : "−"}</td>
          <td><button class="btn btn-sm btn-secondary" onclick="openRakutenProductModal(${p.id})">編集</button></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table></div>`;
}

function renderRakutenPagination(total) {
  const pages = Math.ceil(total / rPageSize);
  const countLabel = `<span style="color:var(--gray-500);font-size:12px">全${fmt(total)}件</span>`;
  if (pages <= 1) { $("r-product-pagination").innerHTML = countLabel; return; }
  let html = countLabel + " ";
  const start = Math.max(1, rProductPage - 2);
  const end = Math.min(pages, rProductPage + 2);
  if (start > 1) html += `<button class="page-btn" onclick="rProductPage=1;loadRakutenProducts()">1</button>${start > 2 ? "…" : ""}`;
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === rProductPage ? "active" : ""}" onclick="rProductPage=${i};loadRakutenProducts()">${i}</button>`;
  }
  if (end < pages) html += `${end < pages - 1 ? "…" : ""}<button class="page-btn" onclick="rProductPage=${pages};loadRakutenProducts()">${pages}</button>`;
  $("r-product-pagination").innerHTML = html;
}

async function openRakutenProductModal(id) {
  const p = await api("GET", `/api/products/${id}`);
  openModal("楽天情報を編集", `
    <div style="margin-bottom:12px;font-weight:600">${esc(p.title)}${p.variation ? " / " + esc(p.variation) : ""}</div>
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:16px">NF-SKU: ${esc(p.nf_sku)}</div>
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">楽天商品管理番号</label>
        <input class="input" id="rf-item_number" value="${esc(p.rakuten_item_number || "")}" placeholder="例: AY130-2"></div>
      <div class="form-group"><label class="form-label">楽天販売価格 (¥)</label>
        <input class="input" id="rf-price" type="number" min="0" value="${p.rakuten_price || 0}"></div>
      <div class="form-group"><label class="form-label">楽天在庫数</label>
        <input class="input" id="rf-stock" type="number" min="0" value="${p.rakuten_stock || 0}"></div>
    </div>
  `, async () => {
    await api("PATCH", `/api/products/${id}/rakuten`, {
      rakuten_item_number: $("rf-item_number").value.trim(),
      rakuten_price: parseFloat($("rf-price").value) || 0,
      rakuten_stock: parseInt($("rf-stock").value) || 0,
    });
    toast("楽天情報を更新しました");
    loadRakutenProducts();
  });
}

$("r-product-search").addEventListener("input", e => {
  clearTimeout(rSearchTimer);
  rSearchTimer = setTimeout(() => { rProductSearch = e.target.value; rProductPage = 1; loadRakutenProducts(); }, 300);
});
$("r-rakuten-only").addEventListener("change", e => { rRakutenOnly = e.target.checked; rProductPage = 1; loadRakutenProducts(); });

$("btn-r-import").addEventListener("click", openRakutenImportModal);

function openRakutenImportModal() {
  openModal("楽天 CSVインポート", `
    <div style="display:flex;flex-direction:column;gap:20px">
      <div style="background:var(--blue-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">商品CSV</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          RMS → 店舗設定 → <b>1.商品管理</b> → ② CSV一括編集 → <b>「CSVダウンロード」</b><br>
          <span style="color:var(--gray-500)">更新内容：楽天商品番号・楽天価格・楽天在庫数（SKU管理番号で照合）</span>
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".csv" style="display:none" id="r-product-csv">
        </label>
        <div id="r-product-result" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";

  $("r-product-csv").addEventListener("change", async e => {
    const file = e.target.files[0]; if (!file) return;
    const resultEl = $("r-product-result");
    resultEl.textContent = "処理中...";
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch("/api/import/rakuten-products", { method: "POST", body: form });
      const data = await res.json();
      resultEl.innerHTML = `<span style="color:var(--green)">✓ 更新: ${data.updated}件 / スキップ: ${data.skipped}件${data.errors.length ? ` / エラー: ${data.errors.length}件` : ""}</span>`;
      loadRakutenProducts();
      if (currentPage === "r-dashboard") loadRakutenDashboard();
    } catch(err) { resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`; }
    e.target.value = "";
  });
}

// ---- Rakuten Orders Page ----

let rCurrentTab = "orders";

function switchRakutenTab(tab) {
  rCurrentTab = tab;
  const isOrders = tab === "orders";
  $("r-orders-content").style.display = isOrders ? "" : "none";
  $("r-reorder-content").style.display = isOrders ? "none" : "";
  $("r-tab-btn-orders").classList.toggle("active", isOrders);
  $("r-tab-btn-reorder").classList.toggle("active", !isOrders);
  if (isOrders) loadRakutenOrders();
  else loadRakutenReorderSuggestions();
}

async function loadRakutenOrdersPage() {
  switchRakutenTab("orders");
}

let rOrderSearchTimer;
let rReorderAll = [];
let rReorderSearch = "";

async function loadRakutenOrders() {
  const search = $("r-order-search")?.value || "";
  const dateFrom = $("r-order-date-from")?.value || "";
  const params = new URLSearchParams({ search, date_from: dateFrom, limit: 200 });
  const data = await api("GET", `/api/rakuten/orders?${params}`);

  const totalQty = data.items.reduce((s, o) => s + o.quantity, 0);
  const totalSales = data.items.reduce((s, o) => s + o.total_price, 0);
  $("r-order-stat").textContent = `${fmt(data.total)}件 / 合計 ${fmt(totalQty)}個 / ${fmtPrice(totalSales)}`;

  if (data.items.length === 0) {
    $("r-order-table-wrap").innerHTML = `<div class="empty">受注データがありません</div>`;
    return;
  }
  $("r-order-table-wrap").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>注文日</th><th>注文番号</th><th>商品名</th><th>楽天番号</th><th>個数</th><th>単価</th><th>小計</th><th></th></tr></thead>
      <tbody>${data.items.map(o => `
        <tr>
          <td>${o.order_date}</td>
          <td style="font-size:12px">${esc(o.order_number)}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(o.product_title || o.item_name)}">${esc(o.product_title || o.item_name)}</td>
          <td style="font-size:12px">${esc(o.item_number)}</td>
          <td style="font-weight:600">${fmt(o.quantity)}</td>
          <td>${o.unit_price ? fmtPrice(o.unit_price) : "−"}</td>
          <td>${fmtPrice(o.total_price)}</td>
          <td><button class="btn-icon" onclick="deleteRakutenOrder(${o.id})">🗑️</button></td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
}

async function deleteRakutenOrder(id) {
  if (!confirm("この受注記録を削除しますか？")) return;
  await api("DELETE", `/api/rakuten/orders/${id}`);
  toast("削除しました");
  loadRakutenOrders();
}

$("btn-r-order-import").addEventListener("click", openRakutenOrderImportModal);

function openRakutenOrderImportModal() {
  openModal("楽天 受注CSVインポート", `
    <div style="background:var(--blue-light);border-radius:8px;padding:16px">
      <div style="font-weight:700;margin-bottom:8px">受注CSV</div>
      <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
        RMS → <b>受注・決済管理</b> → 受注管理 → <b>「データダウンロード」</b><br>
        <span style="color:var(--gray-500)">更新内容：注文番号・商品名・数量・金額（重複は自動スキップ）</span>
      </div>
      <label class="btn btn-secondary" style="width:fit-content">
        ファイルを選択してインポート
        <input type="file" accept=".csv" style="display:none" id="r-order-csv">
      </label>
      <div id="r-order-import-result" style="margin-top:8px;font-size:12px"></div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";

  $("r-order-csv").addEventListener("change", async e => {
    const file = e.target.files[0]; if (!file) return;
    const resultEl = $("r-order-import-result");
    resultEl.textContent = "処理中...";
    const form = new FormData(); form.append("file", file);
    try {
      const res = await fetch("/api/import/rakuten-orders", { method: "POST", body: form });
      const data = await res.json();
      const warnPart = data.skipped > 0 ? ` / スキップ(重複): ${data.skipped}件` : "";
      resultEl.innerHTML = `<span style="color:var(--green)">✓ ${data.imported}件インポートしました${warnPart}${data.errors.length ? ` / エラー: ${data.errors.length}件` : ""}</span>`;
      loadRakutenOrders();
      if (currentPage === "r-dashboard") loadRakutenDashboard();
    } catch(err) { resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`; }
    e.target.value = "";
  });
}

let rOrderSearchTimer2;
$("r-order-search").addEventListener("input", () => {
  clearTimeout(rOrderSearchTimer2);
  rOrderSearchTimer2 = setTimeout(loadRakutenOrders, 300);
});
$("r-order-date-from").addEventListener("change", loadRakutenOrders);

// ---- Rakuten Reorder ----

async function loadRakutenReorderSuggestions() {
  await loadPendingQtys();
  const data = await api("GET", "/api/rakuten/products?rakuten_only=true&limit=9999");
  rReorderAll = data.items
    .map(p => ({ ...p, _oq: calcRakutenOrderQty(p) }))
    .filter(p => p._oq > 0);
  const dateInput = $("r-bulk-order-date");
  if (dateInput && !dateInput.value) dateInput.value = today();
  renderRakutenReorderTable();
}

function calcRakutenOrderQty(p) {
  if (p.discontinued) return 0;
  const pending = pendingQtys[p.id] || 0;
  const rp = calcRakutenReorderPoint(p);
  return Math.max(0, rp - (p.rakuten_stock || 0) - pending);
}

function renderRakutenReorderTable() {
  const wrap = $("r-reorder-table-wrap");
  if (!wrap) return;
  const q = rReorderSearch.toLowerCase();
  const items = rReorderAll.filter(p =>
    !q || p.title.toLowerCase().includes(q) || (p.rakuten_item_number || "").toLowerCase().includes(q)
  );
  if (items.length === 0) {
    wrap.innerHTML = `<div class="empty">楽天在庫で発注が必要な商品はありません</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th style="width:28px"><input type="checkbox" onchange="document.querySelectorAll('.r-reorder-check').forEach(c=>c.checked=this.checked)"></th>
        <th>商品名</th><th>楽天番号</th>
        <th title="過去30日の楽天受注合計">楽天月販(30日)</th>
        <th>楽天在庫</th><th style="color:var(--blue)">発注済み</th>
        <th style="color:var(--red)" title="楽天月販 × リードタイム − 楽天在庫">発注数</th>
        <th>発注数入力</th>
      </tr></thead>
      <tbody>${items.map((p, idx) => `
        <tr class="${p.rakuten_stock === 0 ? "low-stock" : ""}">
          <td style="text-align:center"><input type="checkbox" class="r-reorder-check" data-sku="${esc(p.sku || p.nf_sku)}" data-qty-id="rrqty-${idx}"></td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
          <td>${esc(p.rakuten_item_number)}</td>
          <td style="color:var(--blue)">${fmt(p.rakuten_monthly_sales || 0)}</td>
          <td style="font-weight:600;color:${p.rakuten_stock === 0 ? "var(--red)" : "inherit"}">${fmt(p.rakuten_stock)}</td>
          <td style="color:var(--blue)">${pendingQtys[p.id] ? fmt(pendingQtys[p.id]) : "−"}</td>
          <td style="font-weight:700;color:var(--red)">${fmt(p._oq)}</td>
          <td><input type="number" id="rrqty-${idx}" class="input" min="0" value="${p._oq}" style="width:70px;padding:4px 6px"></td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
}

async function rBulkRegisterOrderPlan() {
  const date = $("r-bulk-order-date")?.value;
  if (!date) { toast("発注日を入力してください", "error"); return; }
  const checks = document.querySelectorAll(".r-reorder-check:checked");
  if (checks.length === 0) { toast("商品をチェックしてください", "error"); return; }
  const items = [];
  checks.forEach(cb => {
    const sku = cb.dataset.sku;
    const qty = parseInt(document.getElementById(cb.dataset.qtyId)?.value || "0");
    if (sku && qty > 0) items.push({ sku, quantity: qty });
  });
  if (items.length === 0) { toast("発注数が0の商品は登録できません", "error"); return; }
  await api("POST", "/api/order-plans/bulk", { plan_date: date, items });
  toast(`${items.length}件を発注プランに登録しました`);
  await loadPendingQtys();
  loadRakutenReorderSuggestions();
}

// ---- SaleMonster ----

async function loadSelmonDashboard() {
  const d = await api("GET", "/api/selmon/dashboard");

  $("sm-stat-grid").innerHTML = `
    <div class="stat-card">
      <div class="stat-label">登録済み</div>
      <div class="stat-value" style="color:var(--green)">${fmt(d.registered)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">未登録</div>
      <div class="stat-value" style="color:var(--gray-500)">${fmt(d.unregistered)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">削除</div>
      <div class="stat-value" style="color:var(--gray-400)">${fmt(d.deleted)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">審査OK</div>
      <div class="stat-value" style="color:var(--green)">${fmt(d.review_ok)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">審査NG</div>
      <div class="stat-value" style="color:var(--red)">${fmt(d.review_ng)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">過去7日売上</div>
      <div class="stat-value">${fmt(d.total_sales_7d)}<span style="font-size:14px;font-weight:400">個</span></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">過去30日売上</div>
      <div class="stat-value">${fmt(d.total_sales_30d)}<span style="font-size:14px;font-weight:400">個</span></div>
    </div>`;

  if (d.ng_items.length === 0) {
    $("sm-ng-list").innerHTML = `<div class="empty">審査NG商品はありません</div>`;
  } else {
    $("sm-ng-list").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>商品名</th><th>バリエーション</th><th>SKU</th><th>コメント</th></tr></thead>
        <tbody>${d.ng_items.map(p => `
          <tr>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
            <td>${esc(p.variation)}</td>
            <td>${esc(p.sku)}</td>
            <td style="color:var(--red);font-size:12px">${esc(p.comment)}</td>
          </tr>`).join("")}
        </tbody></table></div>`;
  }

  if (d.unregistered_items.length === 0) {
    $("sm-unregistered-list").innerHTML = `<div class="empty">未登録商品はありません</div>`;
  } else {
    $("sm-unregistered-list").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>商品名</th><th>バリエーション</th><th>SKU</th></tr></thead>
        <tbody>${d.unregistered_items.map(p => `
          <tr>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
            <td>${esc(p.variation)}</td>
            <td>${esc(p.sku)}</td>
          </tr>`).join("")}
        </tbody></table></div>`;
  }
}

let smPage = 1;
let smPageSize = 100;
let smSearch = "";
let smReviewFilter = "";
let smSortBy = "selmon_sales_30d";
let smSortDir = "desc";

const SM_COLUMNS = [
  { key: "title",            label: "商品名",       sortable: true },
  { key: "variation",        label: "バリエーション", sortable: true },
  { key: "sku",              label: "SKU",          sortable: true },
  { key: "selmon_registered",label: "登録状況",      sortable: true },
  { key: "selmon_review",    label: "審査",          sortable: true },
  { key: "selmon_sales_7d",  label: "7日",           sortable: true },
  { key: "selmon_sales_30d", label: "30日",          sortable: true },
  { key: "selmon_sales_60d", label: "60日",          sortable: true },
  { key: "selmon_sales_90d", label: "90日",          sortable: true },
];

async function loadSelmonProducts() {
  const limit = smPageSize;
  const offset = (smPage - 1) * smPageSize;
  const params = new URLSearchParams({
    search: smSearch, review_filter: smReviewFilter,
    sort_by: smSortBy, sort_dir: smSortDir, limit, offset,
  });
  const data = await api("GET", `/api/selmon/products?${params}`);
  renderSelmonTable(data.items);
  renderPagination2("sm-product-pagination", data.total, smPage, smPageSize,
    p => { smPage = p; loadSelmonProducts(); });
}

function smSortIcon(key) {
  if (smSortBy !== key) return `<span style="color:var(--gray-300);margin-left:4px">⇅</span>`;
  return smSortDir === "asc"
    ? `<span style="color:var(--blue);margin-left:4px">↑</span>`
    : `<span style="color:var(--blue);margin-left:4px">↓</span>`;
}

function onSmSortClick(key) {
  if (smSortBy === key) smSortDir = smSortDir === "asc" ? "desc" : "asc";
  else { smSortBy = key; smSortDir = "desc"; }
  smPage = 1;
  loadSelmonProducts();
}

function renderSelmonTable(items) {
  const thStyle = "cursor:pointer;user-select:none;white-space:nowrap";
  const headers = SM_COLUMNS.map(c =>
    c.sortable
      ? `<th style="${thStyle}" onclick="onSmSortClick('${c.key}')">${c.label}${smSortIcon(c.key)}</th>`
      : `<th>${c.label}</th>`
  ).join("");

  if (items.length === 0) {
    $("sm-product-table-wrap").innerHTML =
      `<div class="table-wrap"><table><thead><tr>${headers}</tr></thead></table></div>` +
      `<div class="empty">条件に一致する商品がありません。先に商品レポートを取り込んでください。</div>`;
    return;
  }

  const reviewBadge = v => {
    if (v === "審査OK") return `<span style="color:var(--green);font-weight:600">✓ OK</span>`;
    if (v === "審査NG") return `<span style="color:var(--red);font-weight:600">✗ NG</span>`;
    return `<span style="color:var(--gray-400)">−</span>`;
  };
  const regBadge = v => {
    if (v === "未登録") return `<span style="color:var(--gray-500)">未登録</span>`;
    if (v === "削除")   return `<span style="color:var(--red)">削除</span>`;
    return `<span style="color:var(--green)">登録済</span>`;
  };
  const salesCell = (v, isBest) =>
    v > 0
      ? `<td style="text-align:right;font-weight:${isBest ? "700" : "400"}">${fmt(v)}</td>`
      : `<td style="text-align:right;color:var(--gray-300)">−</td>`;

  $("sm-product-table-wrap").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>${headers}</tr></thead>
      <tbody>${items.map(p => `
        <tr>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
          <td>${esc(p.variation)}</td>
          <td>${esc(p.sku)}</td>
          <td style="white-space:nowrap">${regBadge(p.selmon_registered)}</td>
          <td style="white-space:nowrap">${reviewBadge(p.selmon_review)}</td>
          ${salesCell(p.selmon_sales_7d,  smSortBy === "selmon_sales_7d")}
          ${salesCell(p.selmon_sales_30d, smSortBy === "selmon_sales_30d")}
          ${salesCell(p.selmon_sales_60d, smSortBy === "selmon_sales_60d")}
          ${salesCell(p.selmon_sales_90d, smSortBy === "selmon_sales_90d")}
        </tr>`).join("")}
      </tbody></table></div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const ss = $("sm-product-search");
  if (ss) ss.addEventListener("input", e => {
    clearTimeout(ss._t);
    ss._t = setTimeout(() => { smSearch = e.target.value; smPage = 1; loadSelmonProducts(); }, 300);
  });
  const sf = $("sm-review-filter");
  if (sf) sf.addEventListener("change", e => { smReviewFilter = e.target.value; smPage = 1; loadSelmonProducts(); });
});

function openSelmonImportModal() {
  openModal("セールモンスター 商品レポート取込", `
    <div style="background:var(--blue-light);border-radius:8px;padding:16px">
      <div style="font-weight:700;margin-bottom:8px">商品レポートCSV</div>
      <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
        セールモンスター → 商品レポート → CSVダウンロード<br>
        ファイル名例: <code>商品レポート_2026-05-19T...csv</code><br>
        <b>更新内容：</b>登録状況・審査状況・過去7/30/60/90日売上個数
      </div>
      <label class="btn btn-secondary" style="width:fit-content">
        ファイルを選択してインポート
        <input type="file" accept=".csv" style="display:none" onchange="doSelmonImport(this)">
      </label>
      <div id="sm-import-result" style="margin-top:8px;font-size:12px"></div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function doSelmonImport(input) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = $("sm-import-result");
  resultEl.textContent = "処理中...";
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/selmon/import-report", { method: "POST", body: form });
    const data = await res.json();
    resultEl.innerHTML = `<span style="color:var(--green)">✓ 更新: ${data.updated}件 / スキップ: ${data.skipped}件</span>`;
    if (currentPage === "sm-dashboard") loadSelmonDashboard();
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`;
  }
  input.value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btn-sm-import");
  if (btn) btn.addEventListener("click", openSelmonImportModal);
});

// ---- Yahoo! ----

async function loadYahooDashboard() {
  const d = await api("GET", "/api/yahoo/dashboard");
  $("y-stat-grid").innerHTML = `
    <div class="stat-card"><div class="stat-label">出品商品数</div><div class="stat-value">${fmt(d.total_products)}</div></div>
    <div class="stat-card"><div class="stat-label">在庫不足</div><div class="stat-value" style="color:var(--red)">${fmt(d.low_stock_count)}</div></div>
    <div class="stat-card"><div class="stat-label">期間販売数</div><div class="stat-value">${fmt(d.monthly_sales_qty)}</div></div>
    <div class="stat-card"><div class="stat-label">期間売上</div><div class="stat-value">${fmtPrice(d.monthly_revenue)}</div></div>`;

  const settings = appSettings;
  const lead = settings.lead_time_months || 1.5;
  const items = await api("GET", "/api/yahoo/products?yahoo_only=true&limit=9999");
  const low = items.items.filter(p =>
    (p.yahoo_monthly_sales > 0 && p.yahoo_stock < Math.ceil(p.yahoo_monthly_sales * lead))
    || (p.yahoo_monthly_sales === 0 && p.yahoo_stock === 0)
  );
  if (low.length === 0) {
    $("y-low-stock-list").innerHTML = `<div class="empty">在庫不足の商品はありません</div>`;
  } else {
    $("y-low-stock-list").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>商品名</th><th>バリエーション</th><th>SKU</th><th>Yahoo在庫</th><th>月販数</th></tr></thead>
        <tbody>${low.map(p => `
          <tr class="${p.yahoo_stock === 0 ? "low-stock" : ""}">
            <td>${esc(p.title)}</td><td>${esc(p.variation)}</td>
            <td>${esc(p.sku)}</td>
            <td style="color:var(--red);font-weight:700">${fmt(p.yahoo_stock)}</td>
            <td>${fmt(p.yahoo_monthly_sales)}</td>
          </tr>`).join("")}
        </tbody></table></div>`;
  }
}

let yPage = 1;
let yPageSize = 50;
let ySearch = "";
let yYahooOnly = false;
let ySortBy = "title";
let ySortDir = "asc";

const Y_COLUMNS = [
  { key: "title",                label: "商品名",        sortable: true },
  { key: "variation",            label: "バリエーション", sortable: true },
  { key: "sku",                  label: "SKU",           sortable: true },
  { key: "yahoo_item_number",    label: "Yahoo商品コード", sortable: true },
  { key: "yahoo_stock",          label: "Yahoo在庫",     sortable: true },
  { key: "yahoo_price",          label: "Yahoo価格",     sortable: true },
  { key: "yahoo_monthly_sales",  label: "販売数",         sortable: true },
  { key: "yahoo_monthly_revenue",label: "売上金額",       sortable: true },
  { key: "yahoo_page_views",     label: "PV",            sortable: true },
  { key: "yahoo_visitors",       label: "訪問者数",       sortable: true },
  { key: "_y_order_qty",         label: "発注提案",       sortable: false },
];

async function loadYahooProducts() {
  const limit = yPageSize === 0 ? 9999 : yPageSize;
  const offset = yPageSize === 0 ? 0 : (yPage - 1) * yPageSize;
  const params = new URLSearchParams({
    search: ySearch, yahoo_only: yYahooOnly,
    sort_by: ySortBy, sort_dir: ySortDir, limit, offset,
  });
  const data = await api("GET", `/api/yahoo/products?${params}`);
  renderYahooTable(data.items);
  if (yPageSize === 0) {
    $("y-product-pagination").innerHTML = `<span style="color:var(--gray-500);font-size:12px">全${fmt(data.total)}件表示中</span>`;
  } else {
    renderPagination2("y-product-pagination", data.total, yPage, yPageSize, p => { yPage = p; loadYahooProducts(); });
  }
}

function renderPagination2(elId, total, current, size, cb) {
  const pages = Math.ceil(total / size);
  const countLabel = `<span style="color:var(--gray-500);font-size:12px">全${fmt(total)}件</span>`;
  if (pages <= 1) { $(elId).innerHTML = countLabel; return; }
  let html = countLabel + " ";
  const start = Math.max(1, current - 2);
  const end   = Math.min(pages, current + 2);
  if (start > 1) html += `<button class="page-btn" onclick="(${cb})(1)">1</button>${start > 2 ? '<span style="padding:0 4px">…</span>' : ""}`;
  for (let i = start; i <= end; i++) html += `<button class="page-btn ${i === current ? "active" : ""}" onclick="(${cb})(${i})">${i}</button>`;
  if (end < pages) html += `${end < pages - 1 ? '<span style="padding:0 4px">…</span>' : ""}<button class="page-btn" onclick="(${cb})(${pages})">${pages}</button>`;
  $(elId).innerHTML = html;
}

function renderYahooTable(items) {
  const lead = appSettings.lead_time_months || 1.5;
  const thStyle = "cursor:pointer;user-select:none;white-space:nowrap";
  const headers = Y_COLUMNS.map(c =>
    c.sortable
      ? `<th style="${thStyle}" onclick="onYSortClick('${c.key}')">${c.label}${ySortBy === c.key ? (ySortDir === "asc" ? ' <span style="color:var(--blue)">↑</span>' : ' <span style="color:var(--blue)">↓</span>') : ' <span style="color:var(--gray-300)">⇅</span>'}</th>`
      : `<th>${c.label}</th>`
  ).join("");

  if (items.length === 0) {
    $("y-product-table-wrap").innerHTML = `<div class="table-wrap"><table><thead><tr>${headers}</tr></thead></table></div><div class="empty">条件に一致する商品がありません</div>`;
    return;
  }

  $("y-product-table-wrap").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>${headers}</tr></thead>
      <tbody>${items.map(p => {
        const oq = p.yahoo_monthly_sales > 0
          ? Math.max(0, Math.ceil(p.yahoo_monthly_sales * lead) - p.yahoo_stock) : 0;
        const isLow = p.yahoo_stock === 0 && !p.discontinued;
        return `<tr class="${isLow ? "low-stock" : ""}">
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.title)}">${esc(p.title)}</td>
          <td>${esc(p.variation)}</td>
          <td>${esc(p.sku)}</td>
          <td>${esc(p.yahoo_item_number || "")}</td>
          <td style="font-weight:600;color:${isLow ? "var(--red)" : "inherit"}">${fmt(p.yahoo_stock)}</td>
          <td>${p.yahoo_price ? fmtPrice(p.yahoo_price) : "−"}</td>
          <td>${fmt(p.yahoo_monthly_sales)}</td>
          <td>${p.yahoo_monthly_revenue ? fmtPrice(p.yahoo_monthly_revenue) : "−"}</td>
          <td>${fmt(p.yahoo_page_views)}</td>
          <td>${fmt(p.yahoo_visitors)}</td>
          <td style="font-weight:${oq > 0 ? "600" : "400"};color:${oq > 0 ? "var(--red)" : "var(--gray-400)"}">${oq > 0 ? fmt(oq) : "−"}</td>
        </tr>`;
      }).join("")}
      </tbody></table></div>`;
}

function onYSortClick(key) {
  if (ySortBy === key) ySortDir = ySortDir === "asc" ? "desc" : "asc";
  else { ySortBy = key; ySortDir = "asc"; }
  yPage = 1;
  loadYahooProducts();
}

function openYahooImportModal() {
  openModal("Yahoo! データ取込", `
    <div style="display:flex;flex-direction:column;gap:20px">
      <div style="background:var(--blue-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">① 在庫CSV（quantity...csv）</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          Yahoo! Store Creator Pro → 在庫管理 → CSVダウンロード<br>
          <b>更新内容：</b>Yahoo在庫数・Yahoo商品コード（sub-codeでSKU照合）
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".csv" style="display:none" onchange="doYahooImport(this,'stock')">
        </label>
        <div id="y-stock-result" style="margin-top:8px;font-size:12px"></div>
      </div>
      <div style="background:var(--green-light);border-radius:8px;padding:16px">
        <div style="font-weight:700;margin-bottom:8px">② 商品分析レポート（yufolife-item_report.csv）</div>
        <div style="font-size:12px;color:var(--gray-700);margin-bottom:12px">
          Yahoo!ショッピング → 販売管理 → 商品分析 → CSVダウンロード<br>
          <b>更新内容：</b>販売数・売上金額・PV・訪問者数（サブコード／商品コードでSKU照合）
        </div>
        <label class="btn btn-secondary" style="width:fit-content">
          ファイルを選択してインポート
          <input type="file" accept=".csv" style="display:none" onchange="doYahooImport(this,'report')">
        </label>
        <div id="y-report-result" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>
  `, null);
  $("modal-save").style.display = "none";
  $("modal-cancel").textContent = "閉じる";
}

async function doYahooImport(input, type) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = $(type === "stock" ? "y-stock-result" : "y-report-result");
  resultEl.textContent = "処理中...";
  const form = new FormData();
  form.append("file", file);
  const endpoint = type === "stock" ? "/api/yahoo/import-stock" : "/api/yahoo/import-report";
  try {
    const res = await fetch(endpoint, { method: "POST", body: form });
    const data = await res.json();
    resultEl.innerHTML = `<span style="color:var(--green)">✓ 更新: ${data.updated}件 / スキップ: ${data.skipped}件</span>`;
    if (currentPage === "y-products") loadYahooProducts();
    if (currentPage === "y-dashboard") loadYahooDashboard();
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--red)">エラー: ${err.message}</span>`;
  }
  input.value = "";
}

let ySearchTimer;
document.addEventListener("DOMContentLoaded", () => {
  const ys = $("y-product-search");
  if (ys) ys.addEventListener("input", e => {
    clearTimeout(ySearchTimer);
    ySearchTimer = setTimeout(() => { ySearch = e.target.value; yPage = 1; loadYahooProducts(); }, 300);
  });
  const yo = $("y-yahoo-only");
  if (yo) yo.addEventListener("change", e => { yYahooOnly = e.target.checked; yPage = 1; loadYahooProducts(); });
  const bi = $("btn-y-import");
  if (bi) bi.addEventListener("click", openYahooImportModal);
});

// ---- Init ----
(async () => { await Promise.all([loadSettings(), loadPendingQtys()]); loadDashboard(); })();

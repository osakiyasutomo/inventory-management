import csv
import io
import math
import re
import datetime
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
from database import get_db, init_db

app = FastAPI(title="在庫管理システム")

init_db()

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def root():
    return FileResponse("static/index.html")


# --- Models ---

class ProductCreate(BaseModel):
    title: str
    variation: str = ""
    factory: str = ""
    purchase_name: str = ""
    eishin: str = ""
    nf_sku: str = ""
    sku: str = ""
    barcode: str = ""
    amazon_url: str = ""
    cost_price: float = 0
    selling_price: float = 0
    stock: int = 0
    reorder_point: int = 0
    monthly_sales: int = 0
    sessions: int = 0
    order_count: int = 0
    amazon_stock: int = 0
    yahoo_stock: int = 0
    rakuten_stock: int = 0
    mercari_stock: int = 0
    notes: str = ""
    discontinued: int = 0
    sale_start_date: str = ""
    yahoo_item_number: str = ""
    yahoo_price: float = 0

class ProductUpdate(ProductCreate):
    pass

class SupplierCreate(BaseModel):
    name: str
    contact_person: str = ""
    phone: str = ""
    email: str = ""
    address: str = ""
    notes: str = ""

class TransactionCreate(BaseModel):
    product_id: int
    type: str  # 'in' or 'out'
    quantity: int
    unit_price: float = 0
    notes: str = ""
    date: str = ""

class OrderCreate(BaseModel):
    product_id: int
    supplier_id: Optional[int] = None
    quantity: int
    unit_price: float = 0
    order_date: str = ""
    expected_delivery: str = ""
    notes: str = ""

class OrderStatusUpdate(BaseModel):
    status: str

class SettingsUpdate(BaseModel):
    lead_time_months: float
    target_stock_months: float


# --- Products ---

SORTABLE_COLUMNS = {
    "title", "variation", "sku", "nf_sku", "cost_price",
    "selling_price", "stock", "reorder_point", "monthly_sales", "sessions", "order_count", "updated_at",
    "sale_start_date",
}
COMPUTED_SORT = {
    "bulk_rate": "CASE WHEN order_count > 0 THEN CAST(monthly_sales AS REAL) / order_count ELSE 0 END",
}


@app.get("/api/products")
def list_products(
    search: str = Query(""),
    stock_filter: str = Query(""),   # "low" | "ok" | ""
    sort_by: str = Query("title"),
    sort_dir: str = Query("asc"),    # "asc" | "desc"
    limit: int = Query(100),
    offset: int = Query(0),
):
    db = get_db()
    query = "SELECT * FROM products WHERE 1=1"
    params = []
    if search:
        query += " AND (title LIKE ? OR sku LIKE ? OR nf_sku LIKE ? OR barcode LIKE ? OR variation LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s, s, s])
    if stock_filter == "low":
        query += " AND stock <= reorder_point AND reorder_point > 0"
    elif stock_filter == "ok":
        query += " AND (stock > reorder_point OR reorder_point = 0)"

    direction = "DESC" if sort_dir == "desc" else "ASC"
    if sort_by in COMPUTED_SORT:
        col = COMPUTED_SORT[sort_by]
    else:
        col = sort_by if sort_by in SORTABLE_COLUMNS else "title"

    count_query = query.replace("SELECT *", "SELECT COUNT(*)")
    total = db.execute(count_query, params).fetchone()[0]
    query += f" ORDER BY {col} {direction} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = db.execute(query, params).fetchall()
    db.close()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.post("/api/products/bulk-set-reorder-point")
def bulk_set_reorder_point():
    db = get_db()
    settings = {r["key"]: float(r["value"]) for r in db.execute("SELECT key, value FROM settings WHERE key IN ('lead_time_months', 'target_stock_months')").fetchall()}
    lead_time = settings.get("lead_time_months", 1.5)
    rows = db.execute("SELECT id, monthly_sales FROM products WHERE monthly_sales > 0").fetchall()
    updated = 0
    for row in rows:
        rp = math.ceil(row["monthly_sales"] * lead_time)
        db.execute("UPDATE products SET reorder_point = ? WHERE id = ?", (rp, row["id"]))
        updated += 1
    db.commit()
    db.close()
    return {"updated": updated}


@app.get("/api/products/low-stock")
def low_stock_products():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM products WHERE stock <= reorder_point AND reorder_point > 0 AND (discontinued IS NULL OR discontinued = 0) ORDER BY stock ASC"
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


EXPORT_FIELDS = [
    ("id", "ID"),
    ("title", "商品タイトル"),
    ("variation", "バリエーション"),
    ("factory", "仕入れ工場"),
    ("purchase_name", "仕入れ名"),
    ("eishin", "衛進"),
    ("nf_sku", "NF-SKU"),
    ("sku", "SKU"),
    ("barcode", "バーコード"),
    ("amazon_url", "Amazon URL"),
    ("cost_price", "仕入価格"),
    ("selling_price", "販売価格"),
    ("stock", "在庫数"),
    ("reorder_point", "発注点"),
    ("monthly_sales", "月間販売数"),
    ("sessions", "セッション数"),
    ("order_count", "注文件数"),
    ("notes", "メモ"),
    ("sale_start_date", "販売開始日"),
]


@app.get("/api/products/export-csv")
def export_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM products ORDER BY id").fetchall()
    db.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([label for _, label in EXPORT_FIELDS])
    for row in rows:
        writer.writerow([row[field] for field, _ in EXPORT_FIELDS])

    content = output.getvalue().encode("utf-8-sig")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''%E5%9C%A8%E5%BA%AB%E3%83%87%E3%83%BC%E3%82%BF.csv"},
    )


@app.post("/api/products/import-listing-report")
async def import_listing_report(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    db = get_db()
    updated = 0
    unmatched = []

    for row in reader:
        sku = (row.get("出品者SKU") or "").strip()
        date_str = (row.get("出品日") or "").strip()
        if not sku or not date_str:
            continue
        date_part = date_str.split(" ")[0].replace("/", "-")
        product_id = _find_product_by_sku(db, sku)
        if product_id:
            db.execute("UPDATE products SET sale_start_date=? WHERE id=?", (date_part, product_id))
            updated += 1
        else:
            unmatched.append(sku)

    db.commit()
    db.close()
    return {"updated": updated, "unmatched": unmatched}


@app.get("/api/products/{product_id}")
def get_product(product_id: int):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    return dict(row)


@app.post("/api/products", status_code=201)
def create_product(data: ProductCreate):
    db = get_db()
    cur = db.execute(
        """INSERT INTO products (title,variation,factory,purchase_name,eishin,nf_sku,sku,barcode,
           amazon_url,cost_price,selling_price,stock,reorder_point,monthly_sales,sessions,order_count,
           amazon_stock,yahoo_stock,rakuten_stock,mercari_stock,notes,discontinued,sale_start_date,
           yahoo_item_number,yahoo_price)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.title, data.variation, data.factory, data.purchase_name, data.eishin,
         data.nf_sku, data.sku, data.barcode, data.amazon_url, data.cost_price,
         data.selling_price, data.stock, data.reorder_point, data.monthly_sales, data.sessions, data.order_count,
         data.amazon_stock, data.yahoo_stock, data.rakuten_stock, data.mercari_stock, data.notes, data.discontinued,
         data.sale_start_date, data.yahoo_item_number, data.yahoo_price),
    )
    db.commit()
    row = db.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
    db.close()
    return dict(row)


@app.put("/api/products/{product_id}")
def update_product(product_id: int, data: ProductUpdate):
    db = get_db()
    db.execute(
        """UPDATE products SET title=?,variation=?,factory=?,purchase_name=?,eishin=?,nf_sku=?,sku=?,
           barcode=?,amazon_url=?,cost_price=?,selling_price=?,stock=?,reorder_point=?,monthly_sales=?,sessions=?,order_count=?,
           amazon_stock=?,yahoo_stock=?,rakuten_stock=?,mercari_stock=?,notes=?,discontinued=?,sale_start_date=?,
           yahoo_item_number=?,yahoo_price=?
           WHERE id=?""",
        (data.title, data.variation, data.factory, data.purchase_name, data.eishin,
         data.nf_sku, data.sku, data.barcode, data.amazon_url, data.cost_price,
         data.selling_price, data.stock, data.reorder_point, data.monthly_sales, data.sessions, data.order_count,
         data.amazon_stock, data.yahoo_stock, data.rakuten_stock, data.mercari_stock, data.notes, data.discontinued,
         data.sale_start_date, data.yahoo_item_number, data.yahoo_price, product_id),
    )
    db.commit()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    return dict(row)


class ChannelStockUpdate(BaseModel):
    amazon_stock: int = 0
    yahoo_stock: int = 0
    rakuten_stock: int = 0
    mercari_stock: int = 0

@app.patch("/api/products/{product_id}/channel-stock")
def update_channel_stock(product_id: int, data: ChannelStockUpdate):
    db = get_db()
    db.execute(
        "UPDATE products SET amazon_stock=?,yahoo_stock=?,rakuten_stock=?,mercari_stock=? WHERE id=?",
        (data.amazon_stock, data.yahoo_stock, data.rakuten_stock, data.mercari_stock, product_id),
    )
    db.commit()
    db.close()
    return {"ok": True}


@app.patch("/api/products/{product_id}/discontinued")
def toggle_discontinued(product_id: int):
    db = get_db()
    row = db.execute("SELECT discontinued FROM products WHERE id=?", (product_id,)).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Product not found")
    new_val = 0 if row["discontinued"] else 1
    db.execute("UPDATE products SET discontinued=? WHERE id=?", (new_val, product_id))
    db.commit()
    db.close()
    return {"discontinued": new_val}


@app.patch("/api/products/{product_id}/stock")
def update_stock(product_id: int, body: dict):
    db = get_db()
    val = int(body.get("value", 0))
    row = db.execute("SELECT id FROM products WHERE id=?", (product_id,)).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Product not found")
    db.execute("UPDATE products SET stock=? WHERE id=?", (val, product_id))
    db.commit()
    db.close()
    return {"stock": val}


@app.delete("/api/products/{product_id}", status_code=204)
def delete_product(product_id: int):
    db = get_db()
    db.execute("DELETE FROM products WHERE id = ?", (product_id,))
    db.commit()
    db.close()


IMPORT_FIELD_MAP = {
    "商品タイトル": "title", "title": "title",
    "バリエーション": "variation", "variation": "variation",
    "仕入れ工場": "factory", "factory": "factory",
    "仕入れ名": "purchase_name", "purchase_name": "purchase_name",
    "衛進": "eishin", "eishin": "eishin",
    "NF-SKU": "nf_sku", "nf_sku": "nf_sku",
    "SKU": "sku", "sku": "sku",
    "バーコード": "barcode", "barcode": "barcode",
    "Amazon URL": "amazon_url", "amazon_url": "amazon_url",
    "仕入価格": "cost_price", "cost_price": "cost_price",
    "販売価格": "selling_price", "selling_price": "selling_price",
    "在庫数": "stock", "stock": "stock",
    "発注点": "reorder_point", "reorder_point": "reorder_point",
    "月間販売数": "monthly_sales", "monthly_sales": "monthly_sales",
    "セッション数": "sessions", "sessions": "sessions",
    "注文件数": "order_count", "order_count": "order_count",
    "メモ": "notes", "notes": "notes",
    "販売開始日": "sale_start_date", "sale_start_date": "sale_start_date",
}


@app.post("/api/products/import-csv")
async def import_csv(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text))
    db = get_db()
    updated = 0
    created = 0
    errors = []

    for i, row in enumerate(reader, start=2):
        # ID列があればUPDATE、なければINSERT
        row_id = row.get("ID", "").strip()

        mapped = {}
        for csv_key, value in row.items():
            if csv_key and csv_key in IMPORT_FIELD_MAP:
                mapped[IMPORT_FIELD_MAP[csv_key]] = value or ""

        if not mapped.get("title"):
            errors.append(f"行{i}: 商品タイトルが空です")
            continue

        try:
            if row_id and row_id.isdigit():
                # エクスポートしたCSVを編集して戻す場合：IDで既存レコードを上書き
                db.execute(
                    """UPDATE products SET title=?,variation=?,factory=?,purchase_name=?,eishin=?,
                       nf_sku=?,sku=?,barcode=?,amazon_url=?,cost_price=?,selling_price=?,
                       stock=?,reorder_point=?,monthly_sales=?,sessions=?,order_count=?,notes=?,sale_start_date=? WHERE id=?""",
                    (
                        mapped.get("title", ""),
                        mapped.get("variation", ""),
                        mapped.get("factory", ""),
                        mapped.get("purchase_name", ""),
                        mapped.get("eishin", ""),
                        mapped.get("nf_sku", ""),
                        mapped.get("sku", ""),
                        mapped.get("barcode", ""),
                        mapped.get("amazon_url", ""),
                        float(mapped.get("cost_price", 0) or 0),
                        float(mapped.get("selling_price", 0) or 0),
                        int(mapped.get("stock", 0) or 0),
                        int(mapped.get("reorder_point", 0) or 0),
                        int(mapped.get("monthly_sales", 0) or 0),
                        int(mapped.get("sessions", 0) or 0),
                        int(mapped.get("order_count", 0) or 0),
                        mapped.get("notes", ""),
                        mapped.get("sale_start_date", ""),
                        int(row_id),
                    ),
                )
                updated += 1
            else:
                db.execute(
                    """INSERT INTO products (title,variation,factory,purchase_name,eishin,nf_sku,sku,barcode,
                       amazon_url,cost_price,selling_price,stock,reorder_point,monthly_sales,sessions,order_count,notes,sale_start_date)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        mapped.get("title", ""),
                        mapped.get("variation", ""),
                        mapped.get("factory", ""),
                        mapped.get("purchase_name", ""),
                        mapped.get("eishin", ""),
                        mapped.get("nf_sku", ""),
                        mapped.get("sku", ""),
                        mapped.get("barcode", ""),
                        mapped.get("amazon_url", ""),
                        float(mapped.get("cost_price", 0) or 0),
                        float(mapped.get("selling_price", 0) or 0),
                        int(mapped.get("stock", 0) or 0),
                        int(mapped.get("reorder_point", 0) or 0),
                        int(mapped.get("monthly_sales", 0) or 0),
                        int(mapped.get("sessions", 0) or 0),
                        int(mapped.get("order_count", 0) or 0),
                        mapped.get("notes", ""),
                        mapped.get("sale_start_date", ""),
                    ),
                )
                created += 1
        except Exception as e:
            errors.append(f"行{i}: {str(e)}")

    db.commit()
    db.close()
    return {"updated": updated, "created": created, "errors": errors}


def _decode_csv(content: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return content.decode("cp932", errors="replace")


def _clean_price(val: str) -> float:
    if not val:
        return 0.0
    return float("".join(c for c in val if c.isdigit() or c == ".") or 0)


@app.post("/api/import/amazon-fba")
async def import_amazon_fba(file: UploadFile = File(...)):
    """FBA在庫管理CSVをインポート。SKUで既存商品を照合し在庫・価格を更新。未一致は新規作成。"""
    content = await file.read()
    text = _decode_csv(content)
    first_line = text.splitlines()[0] if text.strip() else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    updated = 0
    created = 0
    skipped = 0
    errors = []

    db = get_db()
    for i, row in enumerate(reader, start=2):
        sku = (row.get("出品者SKU") or "").strip()
        title = (row.get("商品名") or "").strip()
        price = _clean_price(row.get("価格") or "")
        # 合計 - 注文済み = 実際の出荷可能在庫
        stock_total_raw = row.get("Amazon出荷在庫(合計)") or ""
        stock_ordered_raw = row.get("Amazon出荷在庫(引当済み)") or ""
        try:
            stock_total = int(float(stock_total_raw.strip())) if stock_total_raw.strip() else 0
        except ValueError:
            stock_total = 0
        try:
            stock_ordered = int(float(stock_ordered_raw.strip())) if stock_ordered_raw.strip() else 0
        except ValueError:
            stock_ordered = 0
        stock = max(0, stock_total - stock_ordered)
        asin = (row.get("ASIN") or "").strip()
        amazon_url = f"https://www.amazon.co.jp/dp/{asin}" if asin else ""

        if not sku and not title:
            skipped += 1
            continue

        try:
            existing = db.execute(
                "SELECT id FROM products WHERE sku = ? AND sku != ''", (sku,)
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE products SET stock=?, selling_price=CASE WHEN ?=0 THEN selling_price ELSE ? END,"
                    " amazon_url=CASE WHEN ?='' THEN amazon_url ELSE ? END WHERE id=?",
                    (stock, price, price, amazon_url, amazon_url, existing["id"]),
                )
                updated += 1
            else:
                db.execute(
                    "INSERT INTO products (title, sku, selling_price, stock, amazon_url) VALUES (?,?,?,?,?)",
                    (title or sku, sku, price, stock, amazon_url),
                )
                created += 1
        except Exception as e:
            errors.append(f"行{i}: {str(e)}")

    db.commit()
    db.close()
    return {"updated": updated, "created": created, "skipped": skipped, "errors": errors}


@app.post("/api/import/amazon-report")
async def import_amazon_report(file: UploadFile = File(...)):
    """ビジネスレポートCSVをインポート。SKUで既存商品を照合し月間販売数を更新。"""
    content = await file.read()
    text = _decode_csv(content)
    lines = [l for l in text.splitlines() if l.strip()]
    first_line = lines[0] if lines else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    updated = 0
    skipped = 0
    errors = []

    db = get_db()
    for i, row in enumerate(reader, start=2):
        sku = (row.get("SKU") or "").strip()
        sales_raw = row.get("注文された商品点数") or ""

        # セッション列をキー名で検索、見つからなければE列（index 4）の値を使用
        sessions_raw = ""
        for k, v in row.items():
            if k and "セッション" in k and "合計" in k:
                sessions_raw = v or ""
                break
        if not sessions_raw:
            for k, v in row.items():
                if k and "セッション" in k:
                    sessions_raw = v or ""
                    break
        if not sessions_raw:
            vals = list(row.values())
            if len(vals) > 4:
                sessions_raw = vals[4] or ""

        order_count_raw = ""
        for k, v in row.items():
            if k and "注文品目総数" in k and "B2B" not in k:
                order_count_raw = v or ""
                break

        try:
            monthly_sales = int(float(sales_raw.replace(",", "").strip())) if sales_raw.strip() else 0
        except ValueError:
            monthly_sales = 0
        try:
            sessions = int(float(sessions_raw.replace(",", "").strip())) if sessions_raw.strip() else 0
        except ValueError:
            sessions = 0
        try:
            order_count = int(float(order_count_raw.replace(",", "").strip())) if order_count_raw.strip() else 0
        except ValueError:
            order_count = 0

        if not sku:
            skipped += 1
            continue

        try:
            existing = db.execute(
                "SELECT id FROM products WHERE sku = ? AND sku != ''", (sku,)
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE products SET monthly_sales=?, sessions=?, order_count=? WHERE id=?",
                    (monthly_sales, sessions, order_count, existing["id"]),
                )
                updated += 1
            else:
                skipped += 1
        except Exception as e:
            errors.append(f"行{i}: {str(e)}")

    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped, "errors": errors}


# --- Suppliers ---

@app.get("/api/suppliers")
def list_suppliers():
    db = get_db()
    rows = db.execute("SELECT * FROM suppliers ORDER BY name").fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.post("/api/suppliers", status_code=201)
def create_supplier(data: SupplierCreate):
    db = get_db()
    cur = db.execute(
        "INSERT INTO suppliers (name,contact_person,phone,email,address,notes) VALUES (?,?,?,?,?,?)",
        (data.name, data.contact_person, data.phone, data.email, data.address, data.notes),
    )
    db.commit()
    row = db.execute("SELECT * FROM suppliers WHERE id = ?", (cur.lastrowid,)).fetchone()
    db.close()
    return dict(row)


@app.put("/api/suppliers/{supplier_id}")
def update_supplier(supplier_id: int, data: SupplierCreate):
    db = get_db()
    db.execute(
        "UPDATE suppliers SET name=?,contact_person=?,phone=?,email=?,address=?,notes=? WHERE id=?",
        (data.name, data.contact_person, data.phone, data.email, data.address, data.notes, supplier_id),
    )
    db.commit()
    row = db.execute("SELECT * FROM suppliers WHERE id = ?", (supplier_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return dict(row)


@app.delete("/api/suppliers/{supplier_id}", status_code=204)
def delete_supplier(supplier_id: int):
    db = get_db()
    db.execute("DELETE FROM suppliers WHERE id = ?", (supplier_id,))
    db.commit()
    db.close()


# --- Inventory transactions ---

@app.get("/api/inventory")
def list_transactions(product_id: Optional[int] = None, limit: int = 200):
    db = get_db()
    if product_id:
        rows = db.execute(
            """SELECT t.*, p.title as product_title FROM inventory_transactions t
               JOIN products p ON p.id = t.product_id
               WHERE t.product_id = ? ORDER BY t.date DESC, t.created_at DESC LIMIT ?""",
            (product_id, limit),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT t.*, p.title as product_title FROM inventory_transactions t
               JOIN products p ON p.id = t.product_id
               ORDER BY t.date DESC, t.created_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.post("/api/inventory", status_code=201)
def record_transaction(data: TransactionCreate):
    if data.type not in ("in", "out"):
        raise HTTPException(status_code=400, detail="type must be 'in' or 'out'")
    if data.quantity <= 0:
        raise HTTPException(status_code=400, detail="quantity must be positive")

    db = get_db()
    product = db.execute("SELECT * FROM products WHERE id = ?", (data.product_id,)).fetchone()
    if not product:
        db.close()
        raise HTTPException(status_code=404, detail="Product not found")

    if data.type == "out" and product["stock"] < data.quantity:
        db.close()
        raise HTTPException(status_code=400, detail="在庫が不足しています")

    delta = data.quantity if data.type == "in" else -data.quantity
    date_val = data.date if data.date else None

    if date_val:
        db.execute(
            "INSERT INTO inventory_transactions (product_id,type,quantity,unit_price,notes,date) VALUES (?,?,?,?,?,?)",
            (data.product_id, data.type, data.quantity, data.unit_price, data.notes, date_val),
        )
    else:
        db.execute(
            "INSERT INTO inventory_transactions (product_id,type,quantity,unit_price,notes) VALUES (?,?,?,?,?)",
            (data.product_id, data.type, data.quantity, data.unit_price, data.notes),
        )
    db.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (delta, data.product_id))
    db.commit()
    db.close()
    return {"ok": True}


# --- Orders ---

@app.get("/api/orders")
def list_orders(status: str = ""):
    db = get_db()
    if status:
        rows = db.execute(
            """SELECT o.*, p.title as product_title, s.name as supplier_name
               FROM orders o
               JOIN products p ON p.id = o.product_id
               LEFT JOIN suppliers s ON s.id = o.supplier_id
               WHERE o.status = ? ORDER BY o.order_date DESC""",
            (status,),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT o.*, p.title as product_title, s.name as supplier_name
               FROM orders o
               JOIN products p ON p.id = o.product_id
               LEFT JOIN suppliers s ON s.id = o.supplier_id
               ORDER BY o.order_date DESC"""
        ).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.post("/api/orders", status_code=201)
def create_order(data: OrderCreate):
    db = get_db()
    order_date = data.order_date if data.order_date else None
    expected_delivery = data.expected_delivery if data.expected_delivery else None
    cur = db.execute(
        """INSERT INTO orders (product_id,supplier_id,quantity,unit_price,order_date,expected_delivery,notes)
           VALUES (?,?,?,?,?,?,?)""",
        (data.product_id, data.supplier_id, data.quantity, data.unit_price,
         order_date, expected_delivery, data.notes),
    )
    db.commit()
    row = db.execute("SELECT * FROM orders WHERE id = ?", (cur.lastrowid,)).fetchone()
    db.close()
    return dict(row)


@app.put("/api/orders/{order_id}/status")
def update_order_status(order_id: int, data: OrderStatusUpdate):
    valid = ("pending", "ordered", "received", "cancelled")
    if data.status not in valid:
        raise HTTPException(status_code=400, detail=f"status must be one of {valid}")
    db = get_db()
    db.execute("UPDATE orders SET status = ? WHERE id = ?", (data.status, order_id))
    db.commit()

    if data.status == "received":
        order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if order:
            db.execute(
                "INSERT INTO inventory_transactions (product_id,type,quantity,unit_price,notes) VALUES (?,?,?,?,?)",
                (order["product_id"], "in", order["quantity"], order["unit_price"], f"発注受領 (注文ID:{order_id})"),
            )
            db.execute("UPDATE products SET stock = stock + ? WHERE id = ?",
                       (order["quantity"], order["product_id"]))
            db.commit()

    db.close()
    return {"ok": True}


@app.delete("/api/orders/{order_id}", status_code=204)
def delete_order(order_id: int):
    db = get_db()
    db.execute("DELETE FROM orders WHERE id = ?", (order_id,))
    db.commit()
    db.close()


# --- Settings ---

@app.get("/api/settings")
def get_settings():
    db = get_db()
    rows = db.execute(
        "SELECT key, value FROM settings WHERE key IN ('lead_time_months', 'target_stock_months')"
    ).fetchall()
    db.close()
    return {r["key"]: float(r["value"]) for r in rows}

@app.put("/api/settings")
def update_settings(data: SettingsUpdate):
    db = get_db()
    db.execute("UPDATE settings SET value=? WHERE key='lead_time_months'", (str(data.lead_time_months),))
    db.execute("UPDATE settings SET value=? WHERE key='target_stock_months'", (str(data.target_stock_months),))
    db.commit()
    db.close()
    return {"ok": True}


# --- Order Plans ---

@app.get("/api/order-plans/template-csv")
def order_plan_template_csv():
    content = "SKU,発注数\nABC-001,100\nABC-002,50\n".encode("utf-8-sig")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''%E7%99%BA%E6%B3%A8%E3%83%86%E3%83%B3%E3%83%97%E3%83%AC%E3%83%BC%E3%83%88.csv"},
    )


@app.post("/api/order-plans/import")
async def import_order_plan(
    plan_date: str = Form(...),
    notes: str = Form(""),
    file: UploadFile = File(...),
):
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text))

    db = get_db()
    cur = db.execute("INSERT INTO order_plans (plan_date, notes) VALUES (?,?)", (plan_date, notes))
    plan_id = cur.lastrowid

    imported = 0
    not_found = 0
    errors = []

    for i, row in enumerate(reader, start=2):
        sku = (row.get("SKU") or "").strip()
        qty_raw = (row.get("発注数") or "").strip()
        if not sku:
            continue
        try:
            qty = int(float(qty_raw)) if qty_raw else 0
        except (ValueError, TypeError):
            errors.append(f"行{i}: 数量エラー")
            continue
        if qty <= 0:
            continue

        product = db.execute("SELECT id FROM products WHERE sku=? AND sku!=''", (sku,)).fetchone()
        product_id = product["id"] if product else None
        if not product_id:
            not_found += 1

        db.execute(
            "INSERT INTO order_plan_items (plan_id,product_id,sku,quantity) VALUES (?,?,?,?)",
            (plan_id, product_id, sku, qty),
        )
        imported += 1

    db.commit()
    db.close()
    return {"plan_id": plan_id, "imported": imported, "not_found": not_found, "errors": errors}


@app.post("/api/order-plans/bulk")
def bulk_create_order_plan(body: dict):
    plan_date = body.get("plan_date", "")
    notes = body.get("notes", "")
    items = body.get("items", [])  # [{sku, quantity}]
    if not plan_date:
        raise HTTPException(status_code=400, detail="plan_date is required")
    if not items:
        raise HTTPException(status_code=400, detail="items is empty")
    db = get_db()
    cur = db.execute("INSERT INTO order_plans (plan_date, notes) VALUES (?,?)", (plan_date, notes))
    plan_id = cur.lastrowid
    imported = 0
    for item in items:
        sku = str(item.get("sku", "")).strip()
        qty = int(item.get("quantity", 0))
        if not sku or qty <= 0:
            continue
        product = db.execute("SELECT id FROM products WHERE sku=? AND sku!=''", (sku,)).fetchone()
        product_id = product["id"] if product else None
        db.execute(
            "INSERT INTO order_plan_items (plan_id,product_id,sku,quantity) VALUES (?,?,?,?)",
            (plan_id, product_id, sku, qty),
        )
        imported += 1
    db.commit()
    db.close()
    return {"plan_id": plan_id, "imported": imported}


@app.get("/api/order-plans")
def list_order_plans():
    db = get_db()
    plans = db.execute("SELECT * FROM order_plans ORDER BY plan_date DESC, created_at DESC").fetchall()
    result = []
    for plan in plans:
        items = db.execute(
            """SELECT opi.*, p.title as product_title, p.variation
               FROM order_plan_items opi
               LEFT JOIN products p ON p.id = opi.product_id
               WHERE opi.plan_id = ? ORDER BY opi.id""",
            (plan["id"],),
        ).fetchall()
        result.append({**dict(plan), "items": [dict(i) for i in items]})
    db.close()
    return result


@app.get("/api/order-plans/history")
def get_order_plan_history():
    db = get_db()
    rows = db.execute("""
        SELECT opi.sku, opi.quantity, op.plan_date,
               p.title as product_title, p.variation
        FROM order_plan_items opi
        JOIN order_plans op ON op.id = opi.plan_id
        LEFT JOIN products p ON p.id = opi.product_id
        ORDER BY opi.sku, op.plan_date DESC
    """).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.delete("/api/order-plans/{plan_id}", status_code=204)
def delete_order_plan(plan_id: int):
    db = get_db()
    db.execute("DELETE FROM order_plan_items WHERE plan_id = ?", (plan_id,))
    db.execute("DELETE FROM order_plans WHERE id = ?", (plan_id,))
    db.commit()
    db.close()


# --- Receipts ---

@app.get("/api/receipts/template-csv")
def receipt_template_csv():
    content = "品番数量\nAY130-2(6)\nAY037-3(2)\n".encode("utf-8-sig")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''%E5%8F%97%E9%A0%98%E3%83%86%E3%83%B3%E3%83%97%E3%83%AC%E3%83%BC%E3%83%88.csv"},
    )


@app.post("/api/receipts/import")
async def import_receipt(
    receipt_date: str = Form(...),
    notes: str = Form(""),
    file: UploadFile = File(...),
):
    content = await file.read()
    text = _decode_csv(content)
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 1行目がヘッダーなら除外（数値で終わらない かつ 括弧数量形式でもない場合）
    if lines:
        first = lines[0]
        parts = [p.strip() for p in re.split(r'[\t,]', first) if p.strip()]
        last_is_num = len(parts) >= 2 and parts[-1].isdigit()
        has_paren_qty = bool(re.search(r'\(\d+\)\s*$', first))
        if not last_is_num and not has_paren_qty:
            lines = lines[1:]

    db = get_db()
    cur = db.execute("INSERT INTO receipts (receipt_date, notes) VALUES (?,?)", (receipt_date, notes))
    receipt_id = cur.lastrowid

    imported = 0
    not_found = 0
    errors = []

    for i, line in enumerate(lines, start=1):
        sku, qty = None, None
        # 形式1: SKU(数量)
        m = re.match(r'^(.+?)\((\d+)\)\s*$', line)
        if m:
            sku = m.group(1).strip()
            qty = int(m.group(2))
        else:
            # 形式2: タブ or カンマ区切り（SKU 商品名 数量 など）
            # 最初の列をSKU、最後の数値列を数量として扱う
            parts = [p.strip() for p in re.split(r'[\t,]', line) if p.strip()]
            if len(parts) >= 2:
                try:
                    qty = int(parts[-1])
                    sku = parts[0]
                except ValueError:
                    pass
        if sku is None or qty is None:
            errors.append(f"行{i}: 形式エラー ({line[:30]})")
            continue
        if qty <= 0:
            continue

        product = db.execute("SELECT id FROM products WHERE sku=? AND sku!=''", (sku,)).fetchone()
        product_id = product["id"] if product else None
        if not product_id:
            not_found += 1

        db.execute(
            "INSERT INTO receipt_items (receipt_id,product_id,sku,quantity) VALUES (?,?,?,?)",
            (receipt_id, product_id, sku, qty),
        )

        imported += 1

    db.commit()
    db.close()
    return {"receipt_id": receipt_id, "imported": imported, "not_found": not_found, "errors": errors}


@app.get("/api/receipts/history")
def get_receipt_history():
    db = get_db()
    rows = db.execute("""
        SELECT ri.sku, ri.quantity, r.receipt_date
        FROM receipt_items ri
        JOIN receipts r ON r.id = ri.receipt_id
        ORDER BY ri.sku, r.receipt_date DESC
    """).fetchall()
    db.close()
    return [dict(r) for r in rows]


@app.get("/api/receipts")
def list_receipts():
    db = get_db()
    receipts = db.execute("SELECT * FROM receipts ORDER BY receipt_date DESC, created_at DESC").fetchall()
    result = []
    for receipt in receipts:
        items = db.execute(
            """SELECT ri.*, p.title as product_title, p.variation
               FROM receipt_items ri
               LEFT JOIN products p ON p.id = ri.product_id
               WHERE ri.receipt_id = ? ORDER BY ri.id""",
            (receipt["id"],),
        ).fetchall()
        result.append({**dict(receipt), "items": [dict(i) for i in items]})
    db.close()
    return result


@app.delete("/api/receipts/{receipt_id}", status_code=204)
def delete_receipt(receipt_id: int):
    db = get_db()
    db.execute("DELETE FROM receipt_items WHERE receipt_id = ?", (receipt_id,))
    db.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
    db.commit()
    db.close()


@app.get("/api/pending-quantities")
def get_pending_quantities():
    db = get_db()
    # manual_pending が設定されている商品はその値を優先
    manual_rows = db.execute(
        "SELECT id, manual_pending FROM products WHERE manual_pending IS NOT NULL"
    ).fetchall()
    plan_rows = db.execute(
        "SELECT product_id, SUM(quantity) as qty FROM order_plan_items WHERE product_id IS NOT NULL GROUP BY product_id"
    ).fetchall()
    order_rows = db.execute(
        "SELECT product_id, SUM(quantity) as qty FROM orders WHERE status IN ('pending','ordered') GROUP BY product_id"
    ).fetchall()
    receipt_rows = db.execute(
        "SELECT product_id, SUM(quantity) as qty FROM receipt_items WHERE product_id IS NOT NULL GROUP BY product_id"
    ).fetchall()
    db.close()

    manual_ids = {row["id"]: row["manual_pending"] for row in manual_rows}

    calc = {}
    for row in plan_rows:
        calc[row["product_id"]] = calc.get(row["product_id"], 0) + row["qty"]
    for row in order_rows:
        calc[row["product_id"]] = calc.get(row["product_id"], 0) + row["qty"]
    for row in receipt_rows:
        calc[row["product_id"]] = calc.get(row["product_id"], 0) - row["qty"]

    result = {k: max(0, v) for k, v in calc.items()}
    # 手動上書き
    for pid, val in manual_ids.items():
        result[pid] = max(0, val)
    return result


@app.patch("/api/products/{product_id}/manual-pending")
def set_manual_pending(product_id: int, body: dict):
    db = get_db()
    val = body.get("value")
    db.execute("UPDATE products SET manual_pending = ? WHERE id = ?", (val, product_id))
    db.commit()
    db.close()
    return {"ok": True}


# --- Rakuten ---



class RakutenProductPatch(BaseModel):
    rakuten_item_number: str = ""
    rakuten_price: float = 0
    rakuten_stock: int = 0

@app.patch("/api/products/{product_id}/rakuten")
def update_product_rakuten(product_id: int, data: RakutenProductPatch):
    db = get_db()
    db.execute(
        "UPDATE products SET rakuten_item_number=?, rakuten_price=?, rakuten_stock=? WHERE id=?",
        (data.rakuten_item_number, data.rakuten_price, data.rakuten_stock, product_id),
    )
    db.commit()
    db.close()
    return {"ok": True}


@app.get("/api/rakuten/dashboard")
def rakuten_dashboard():
    db = get_db()
    settings = {r["key"]: float(r["value"]) for r in db.execute("SELECT key, value FROM settings WHERE key IN ('lead_time_months', 'target_stock_months')").fetchall()}
    lead_time = settings.get("lead_time_months", 1.5)
    first_day = datetime.date.today().replace(day=1).isoformat()
    thirty_ago = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()

    total = db.execute(
        "SELECT COUNT(*) FROM products WHERE rakuten_item_number != '' OR rakuten_stock > 0"
    ).fetchone()[0]

    # 在庫不足 = 楽天受注ベースの発注点を下回っている商品
    products = db.execute(
        """SELECT p.id, p.rakuten_stock,
               COALESCE((SELECT SUM(ro.quantity) FROM rakuten_orders ro
                         WHERE ro.product_id = p.id AND ro.order_date >= ?), 0) as rms
           FROM products p
           WHERE (p.rakuten_item_number != '' OR p.rakuten_stock > 0)""",
        (thirty_ago,),
    ).fetchall()
    low = sum(
        1 for r in products
        if r["rms"] > 0 and r["rakuten_stock"] < math.ceil(r["rms"] * lead_time)
        or r["rms"] == 0 and r["rakuten_stock"] == 0
    )

    monthly_qty = db.execute(
        "SELECT COALESCE(SUM(quantity),0) FROM rakuten_orders WHERE order_date >= ?", (first_day,)
    ).fetchone()[0]
    monthly_revenue = db.execute(
        "SELECT COALESCE(SUM(total_price),0) FROM rakuten_orders WHERE order_date >= ?", (first_day,)
    ).fetchone()[0]
    db.close()
    return {
        "total_products": total,
        "low_stock_count": int(low),
        "monthly_order_qty": int(monthly_qty),
        "monthly_sales": float(monthly_revenue),
    }


R_SORTABLE = {"title", "variation", "sku", "nf_sku", "rakuten_item_number", "rakuten_stock", "rakuten_price"}

@app.get("/api/rakuten/monthly-sales-summary")
def rakuten_monthly_sales_summary():
    db = get_db()
    thirty_ago = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    rows = db.execute(
        "SELECT product_id, SUM(quantity) as total FROM rakuten_orders"
        " WHERE product_id IS NOT NULL AND order_date >= ?"
        " GROUP BY product_id",
        (thirty_ago,),
    ).fetchall()
    db.close()
    return {str(r["product_id"]): int(r["total"]) for r in rows}


@app.get("/api/rakuten/products")
def list_rakuten_products(
    search: str = Query(""),
    rakuten_only: bool = Query(False),
    sort_by: str = Query("title"),
    sort_dir: str = Query("asc"),
    limit: int = Query(100),
    offset: int = Query(0),
):
    db = get_db()
    thirty_ago = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    direction = "DESC" if sort_dir == "desc" else "ASC"

    if sort_by == "rakuten_monthly_sales":
        order_col = (
            f"(SELECT COALESCE(SUM(ro.quantity),0) FROM rakuten_orders ro"
            f" WHERE ro.product_id = p.id AND ro.order_date >= '{thirty_ago}')"
        )
    elif sort_by in R_SORTABLE:
        order_col = f"p.{sort_by}"
    else:
        order_col = "p.title"

    base_select = f"""
        SELECT p.*,
            COALESCE((SELECT SUM(ro.quantity) FROM rakuten_orders ro
                      WHERE ro.product_id = p.id AND ro.order_date >= '{thirty_ago}'), 0)
            AS rakuten_monthly_sales
        FROM products p WHERE 1=1
    """
    count_base = "SELECT COUNT(*) FROM products p WHERE 1=1"
    params: list = []
    count_params: list = []
    if search:
        cond = " AND (p.title LIKE ? OR p.nf_sku LIKE ? OR p.rakuten_item_number LIKE ? OR p.variation LIKE ? OR p.sku LIKE ?)"
        s = f"%{search}%"
        base_select += cond
        count_base += cond
        params.extend([s, s, s, s, s])
        count_params.extend([s, s, s, s, s])
    if rakuten_only:
        cond2 = " AND (p.rakuten_item_number != '' OR p.rakuten_stock > 0)"
        base_select += cond2
        count_base += cond2
    total = db.execute(count_base, count_params).fetchone()[0]
    base_select += f" ORDER BY {order_col} {direction} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = db.execute(base_select, params).fetchall()
    db.close()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.get("/api/rakuten/orders")
def list_rakuten_orders(
    search: str = Query(""),
    date_from: str = Query(""),
    limit: int = Query(200),
    offset: int = Query(0),
):
    db = get_db()
    base = (
        "FROM rakuten_orders ro LEFT JOIN products p ON p.id = ro.product_id WHERE 1=1"
    )
    params: list = []
    if search:
        base += " AND (ro.order_number LIKE ? OR ro.item_name LIKE ? OR ro.item_number LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s])
    if date_from:
        base += " AND ro.order_date >= ?"
        params.append(date_from)
    total = db.execute(f"SELECT COUNT(*) {base}", params).fetchone()[0]
    rows = db.execute(
        f"SELECT ro.*, p.title as product_title, p.variation {base}"
        " ORDER BY ro.order_date DESC, ro.created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    db.close()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.delete("/api/rakuten/orders/{order_id}", status_code=204)
def delete_rakuten_order(order_id: int):
    db = get_db()
    db.execute("DELETE FROM rakuten_orders WHERE id = ?", (order_id,))
    db.commit()
    db.close()


def _get_col(row: dict, candidates: list, default=""):
    for c in candidates:
        if c in row and row[c] is not None:
            v = str(row[c]).strip()
            if v:
                return v
    return default


def _sku_variants(sku: str) -> list:
    """AY0001-1 → [AY0001-1, AY001-1, AY01-1, ...] のようにゼロ埋め違いのバリアントを返す"""
    candidates = [sku]
    m = re.match(r'^([A-Za-z]+)(\d+)([-_].+)?$', sku)
    if m:
        prefix, num_str, suffix = m.groups()
        suffix = suffix or ""
        n = int(num_str)
        for digits in range(1, 6):
            v = f"{prefix}{str(n).zfill(digits)}{suffix}"
            if v not in candidates:
                candidates.append(v)
    return candidates


def _find_product_by_sku(db, sku: str):
    """SKU管理番号でproductsを検索。ゼロ埋め違い・大文字小文字の違いも許容する。"""
    for v in _sku_variants(sku):
        p = db.execute("SELECT id FROM products WHERE sku = ? COLLATE NOCASE", (v,)).fetchone()
        if p:
            return p["id"]
        p = db.execute("SELECT id FROM products WHERE nf_sku = ? COLLATE NOCASE", (v,)).fetchone()
        if p:
            return p["id"]
    return None


def _find_product_by_rakuten_id(db, item_number: str):
    """楽天商品管理番号 or SKUでproductsを検索。マッチ時にrakuten_item_numberを自動設定。"""
    if not item_number:
        return None
    p = db.execute(
        "SELECT id FROM products WHERE rakuten_item_number = ? AND rakuten_item_number != ''",
        (item_number,),
    ).fetchone()
    if p:
        return p["id"]
    pid = _find_product_by_sku(db, item_number)
    if pid:
        db.execute("UPDATE products SET rakuten_item_number = ? WHERE id = ?", (item_number, pid))
        return pid
    return None


@app.get("/api/selmon/dashboard")
def selmon_dashboard():
    db = get_db()
    rows = db.execute(
        "SELECT selmon_registered, selmon_review, selmon_review_comment,"
        " selmon_sales_7d, selmon_sales_30d, selmon_sales_60d, selmon_sales_90d,"
        " title, variation, sku, amazon_stock"
        " FROM products"
    ).fetchall()
    db.close()

    registered = sum(1 for r in rows if r["selmon_registered"] == "")
    unregistered = sum(1 for r in rows if r["selmon_review"] == "" and r["selmon_registered"] == "未登録")
    deleted = sum(1 for r in rows if r["selmon_registered"] == "削除")
    review_ok = sum(1 for r in rows if r["selmon_review"] == "審査OK")
    review_ng = sum(1 for r in rows if r["selmon_review"] == "審査NG")
    total_sales_7d  = sum(r["selmon_sales_7d"]  for r in rows)
    total_sales_30d = sum(r["selmon_sales_30d"] for r in rows)

    ng_items = [
        {"title": r["title"], "variation": r["variation"], "sku": r["sku"],
         "comment": r["selmon_review_comment"]}
        for r in rows if r["selmon_review"] == "審査NG"
    ]
    unregistered_items = [
        {"title": r["title"], "variation": r["variation"], "sku": r["sku"]}
        for r in rows if r["selmon_registered"] == "未登録"
    ]

    return {
        "registered": registered,
        "unregistered": unregistered,
        "deleted": deleted,
        "review_ok": review_ok,
        "review_ng": review_ng,
        "total_sales_7d": total_sales_7d,
        "total_sales_30d": total_sales_30d,
        "ng_items": ng_items,
        "unregistered_items": unregistered_items,
    }


SM_SORTABLE = {"title", "variation", "sku", "selmon_registered", "selmon_review",
               "selmon_sales_7d", "selmon_sales_30d", "selmon_sales_60d", "selmon_sales_90d"}

@app.get("/api/selmon/products")
def list_selmon_products(
    search: str = Query(""),
    review_filter: str = Query(""),   # "ok" | "ng" | ""
    sort_by: str = Query("selmon_sales_30d"),
    sort_dir: str = Query("desc"),
    limit: int = Query(100),
    offset: int = Query(0),
):
    db = get_db()
    direction = "DESC" if sort_dir == "desc" else "ASC"
    order_col = f"p.{sort_by}" if sort_by in SM_SORTABLE else "p.selmon_sales_30d"

    base = "SELECT p.* FROM products p WHERE (p.selmon_review != '' OR p.selmon_registered != '' OR p.selmon_sales_30d > 0)"
    count_base = "SELECT COUNT(*) FROM products p WHERE (p.selmon_review != '' OR p.selmon_registered != '' OR p.selmon_sales_30d > 0)"
    params: list = []
    count_params: list = []

    if search:
        cond = " AND (p.title LIKE ? OR p.sku LIKE ? OR p.variation LIKE ?)"
        s = f"%{search}%"
        base += cond
        count_base += cond
        params.extend([s, s, s])
        count_params.extend([s, s, s])
    if review_filter == "ok":
        c = " AND p.selmon_review = '審査OK'"
        base += c; count_base += c
    elif review_filter == "ng":
        c = " AND p.selmon_review = '審査NG'"
        base += c; count_base += c

    total = db.execute(count_base, count_params).fetchone()[0]
    base += f" ORDER BY {order_col} {direction} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = db.execute(base, params).fetchall()
    db.close()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.post("/api/selmon/import-report")
async def selmon_import_report(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text))
    db = get_db()
    updated = 0
    skipped = 0

    for row in reader:
        sku = (row.get("SKU") or "").strip()
        if not sku:
            skipped += 1
            continue

        def _int(key):
            v = (row.get(key) or "0").replace(",", "").strip()
            try:
                return int(float(v))
            except ValueError:
                return 0

        registered = (row.get("セルモン登録") or "").strip()
        review     = (row.get("セルモン審査状況") or "").strip()
        comment    = (row.get("セルモン審査コメント") or "").strip()
        s7  = _int("過去7日売上個数")
        s30 = _int("過去30日売上個数")
        s60 = _int("過去60日売上個数")
        s90 = _int("過去90日売上個数")

        pid = _find_product_by_sku(db, sku)
        if pid:
            db.execute(
                """UPDATE products SET
                   selmon_registered=?, selmon_review=?, selmon_review_comment=?,
                   selmon_sales_7d=?, selmon_sales_30d=?, selmon_sales_60d=?, selmon_sales_90d=?
                   WHERE id=?""",
                (registered, review, comment, s7, s30, s60, s90, pid),
            )
            updated += 1
        else:
            skipped += 1

    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped}


def _find_product_by_yahoo_code(db, code: str):
    """Yahoo商品コードでproductsを検索。SKUとしても試みる。"""
    if not code:
        return None
    p = db.execute(
        "SELECT id FROM products WHERE yahoo_item_number = ? AND yahoo_item_number != ''", (code,)
    ).fetchone()
    if p:
        return p["id"]
    pid = _find_product_by_sku(db, code)
    if pid:
        db.execute("UPDATE products SET yahoo_item_number = ? WHERE id = ?", (code, pid))
        return pid
    return None


Y_SORTABLE = {"title", "variation", "sku", "yahoo_item_number", "yahoo_stock", "yahoo_price",
              "yahoo_monthly_sales", "yahoo_monthly_revenue", "yahoo_page_views", "yahoo_visitors"}


@app.get("/api/yahoo/products")
def list_yahoo_products(
    search: str = Query(""),
    yahoo_only: bool = Query(False),
    sort_by: str = Query("title"),
    sort_dir: str = Query("asc"),
    limit: int = Query(100),
    offset: int = Query(0),
):
    db = get_db()
    direction = "DESC" if sort_dir == "desc" else "ASC"
    order_col = f"p.{sort_by}" if sort_by in Y_SORTABLE else "p.title"

    base_select = "SELECT p.* FROM products p WHERE 1=1"
    count_base  = "SELECT COUNT(*) FROM products p WHERE 1=1"
    params: list = []
    count_params: list = []

    if search:
        cond = " AND (p.title LIKE ? OR p.sku LIKE ? OR p.yahoo_item_number LIKE ? OR p.variation LIKE ?)"
        s = f"%{search}%"
        base_select += cond
        count_base  += cond
        params.extend([s, s, s, s])
        count_params.extend([s, s, s, s])
    if yahoo_only:
        cond2 = " AND (p.yahoo_item_number != '' OR p.yahoo_stock > 0)"
        base_select += cond2
        count_base  += cond2

    total = db.execute(count_base, count_params).fetchone()[0]
    base_select += f" ORDER BY {order_col} {direction} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    rows = db.execute(base_select, params).fetchall()
    db.close()
    return {"total": total, "items": [dict(r) for r in rows]}


@app.post("/api/yahoo/import-stock")
async def yahoo_import_stock(file: UploadFile = File(...)):
    """Yahoo在庫CSV（quantity...csv）: code, sub-code, quantity"""
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text))
    db = get_db()
    updated = 0
    skipped = 0

    for row in reader:
        code     = (row.get("code") or "").strip()
        sub_code = (row.get("sub-code") or "").strip()
        qty_raw  = (row.get("quantity") or "0").strip()
        try:
            qty = int(float(qty_raw))
        except ValueError:
            skipped += 1
            continue

        if sub_code:
            pid = _find_product_by_sku(db, sub_code)
            if pid:
                db.execute(
                    "UPDATE products SET yahoo_stock=?,"
                    " yahoo_item_number=CASE WHEN yahoo_item_number='' THEN ? ELSE yahoo_item_number END"
                    " WHERE id=?",
                    (qty, code, pid),
                )
                updated += 1
            else:
                skipped += 1
        elif code:
            pid = _find_product_by_yahoo_code(db, code)
            if pid:
                db.execute("UPDATE products SET yahoo_stock=? WHERE id=?", (qty, pid))
                updated += 1
            else:
                skipped += 1

    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped}


@app.post("/api/yahoo/import-report")
async def yahoo_import_report(file: UploadFile = File(...)):
    """Yahoo商品分析レポート: 商品コード, サブコード, 売上合計値, 注文点数合計, PV, 訪問者数"""
    content = await file.read()
    text = _decode_csv(content)
    reader = csv.DictReader(io.StringIO(text))
    db = get_db()
    updated = 0
    skipped = 0

    for row in reader:
        code     = (row.get("商品コード") or "").strip()
        sub_code = (row.get("サブコード") or "").strip()
        try:
            revenue   = float("".join(c for c in (row.get("売上合計値（税込）") or "0") if c.isdigit() or c == ".") or 0)
            sales_qty = int(float((row.get("注文点数合計") or "0").replace(",", "") or 0))
            pv        = int(float((row.get("ページビュー（優良配送あり）") or "0").replace(",", "") or 0)) \
                      + int(float((row.get("ページビュー（優良配送なし）") or "0").replace(",", "") or 0))
            visitors  = int(float((row.get("訪問者数") or "0").replace(",", "") or 0))
        except (ValueError, TypeError):
            skipped += 1
            continue

        pid = None
        if sub_code:
            pid = _find_product_by_sku(db, sub_code)
        if not pid and code:
            pid = _find_product_by_yahoo_code(db, code)

        if pid:
            db.execute(
                """UPDATE products SET
                   yahoo_monthly_sales=?, yahoo_monthly_revenue=?,
                   yahoo_page_views=?, yahoo_visitors=?,
                   yahoo_item_number=CASE WHEN yahoo_item_number='' AND ? != '' THEN ? ELSE yahoo_item_number END
                   WHERE id=?""",
                (sales_qty, revenue, pv, visitors, code, code, pid),
            )
            updated += 1
        else:
            skipped += 1

    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped}


@app.get("/api/yahoo/dashboard")
def yahoo_dashboard():
    db = get_db()
    settings = {r["key"]: float(r["value"]) for r in db.execute("SELECT key, value FROM settings WHERE key IN ('lead_time_months', 'target_stock_months')").fetchall()}
    lead_time = settings.get("lead_time_months", 1.5)

    total = db.execute(
        "SELECT COUNT(*) FROM products WHERE yahoo_item_number != '' OR yahoo_stock > 0"
    ).fetchone()[0]

    products = db.execute(
        "SELECT yahoo_stock, yahoo_monthly_sales FROM products"
        " WHERE yahoo_item_number != '' OR yahoo_stock > 0"
    ).fetchall()
    low = sum(
        1 for p in products
        if (p["yahoo_monthly_sales"] > 0 and p["yahoo_stock"] < math.ceil(p["yahoo_monthly_sales"] * lead_time))
        or (p["yahoo_monthly_sales"] == 0 and p["yahoo_stock"] == 0)
    )

    total_revenue = db.execute(
        "SELECT COALESCE(SUM(yahoo_monthly_revenue),0) FROM products"
        " WHERE yahoo_item_number != '' OR yahoo_stock > 0"
    ).fetchone()[0]
    total_sales = db.execute(
        "SELECT COALESCE(SUM(yahoo_monthly_sales),0) FROM products"
        " WHERE yahoo_item_number != '' OR yahoo_stock > 0"
    ).fetchone()[0]
    db.close()
    return {
        "total_products": total,
        "low_stock_count": int(low),
        "monthly_sales_qty": int(total_sales),
        "monthly_revenue": float(total_revenue),
    }


@app.post("/api/import/rakuten-products")
async def import_rakuten_products(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    first_line = text.splitlines()[0] if text.strip() else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    updated = 0
    skipped = 0
    errors = []
    db = get_db()
    for i, row in enumerate(reader, start=2):
        # 楽天商品管理番号（URL）
        r_item_no = _get_col(row, ["商品管理番号(商品URL)", "商品管理番号", "商品番号"])
        # SKU管理番号 → products.skuと照合
        sku = _get_col(row, ["SKU管理番号", "システム利用SKU番号"])
        price_raw = _get_col(row, ["通常購入販売価格", "販売価格", "PC用販売価格(税込)", "通常販売価格", "価格"])
        stock_raw = _get_col(row, ["在庫数", "在庫数（残数）", "在庫"])

        if not sku:
            skipped += 1
            continue
        try:
            price = float("".join(c for c in price_raw if c.isdigit() or c == ".") or 0) if price_raw else 0
            stock = int(float(stock_raw.replace(",", ""))) if stock_raw else 0
        except ValueError as e:
            errors.append(f"行{i}: {e}")
            continue

        product_id = _find_product_by_sku(db, sku)
        if product_id:
            db.execute(
                "UPDATE products SET rakuten_stock=?,"
                " rakuten_price=CASE WHEN ?=0 THEN rakuten_price ELSE ? END,"
                " rakuten_item_number=CASE WHEN rakuten_item_number='' OR rakuten_item_number IS NULL THEN ? ELSE rakuten_item_number END"
                " WHERE id=?",
                (stock, price, price, r_item_no, product_id),
            )
            updated += 1
        else:
            skipped += 1
    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped, "errors": errors}


@app.post("/api/import/rakuten-stock")
async def import_rakuten_stock(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    first_line = text.splitlines()[0] if text.strip() else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    updated = 0
    skipped = 0
    errors = []
    db = get_db()
    for i, row in enumerate(reader, start=2):
        sku = _get_col(row, ["SKU管理番号", "システム利用SKU番号", "商品管理番号", "在庫管理番号"])
        stock_raw = _get_col(row, ["在庫数", "在庫"])
        if not sku:
            skipped += 1
            continue
        try:
            stock = int(float(stock_raw.replace(",", ""))) if stock_raw else 0
        except ValueError as e:
            errors.append(f"行{i}: {e}")
            continue
        product_id = _find_product_by_sku(db, sku)
        if product_id:
            db.execute("UPDATE products SET rakuten_stock=? WHERE id=?", (stock, product_id))
            updated += 1
        else:
            skipped += 1
    db.commit()
    db.close()
    return {"updated": updated, "skipped": skipped, "errors": errors}


@app.post("/api/import/rakuten-orders")
async def import_rakuten_orders(file: UploadFile = File(...)):
    content = await file.read()
    text = _decode_csv(content)
    first_line = text.splitlines()[0] if text.strip() else ""
    delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    imported = 0
    skipped = 0
    errors = []
    db = get_db()
    # (注文番号, SKU) ペアで重複チェック
    existing = set(
        (r[0], r[1]) for r in db.execute(
            "SELECT order_number, item_number FROM rakuten_orders"
        ).fetchall()
    )
    for i, row in enumerate(reader, start=2):
        order_number = _get_col(row, ["注文番号"])
        order_date_raw = _get_col(row, ["注文日", "注文日時"])
        sku = _get_col(row, ["SKU管理番号", "システム利用SKU番号"])
        r_item_no = _get_col(row, ["商品管理番号", "商品番号"])
        item_name = _get_col(row, ["商品名(選択肢含む)", "商品名"])
        qty_raw = _get_col(row, ["個数", "数量"])
        unit_raw = _get_col(row, ["単価", "通常価格", "販売価格"])

        if not order_number:
            skipped += 1
            continue

        item_key = sku or r_item_no or ""
        if (order_number, item_key) in existing:
            skipped += 1
            continue

        order_date = order_date_raw[:10].replace("/", "-") if order_date_raw else ""
        try:
            qty = int(float(qty_raw.replace(",", ""))) if qty_raw else 0
            unit_price = float("".join(c for c in unit_raw if c.isdigit() or c == ".") or 0) if unit_raw else 0
            total_price = unit_price * qty  # 単価 × 個数
        except ValueError as e:
            errors.append(f"行{i}: {e}")
            continue
        if qty <= 0:
            skipped += 1
            continue

        # SKU管理番号 → products.sku で照合、なければ商品管理番号で照合
        product_id = None
        if sku:
            product_id = _find_product_by_sku(db, sku)
        if not product_id and r_item_no:
            product_id = _find_product_by_rakuten_id(db, r_item_no)

        db.execute(
            "INSERT INTO rakuten_orders (order_number,order_date,item_number,product_id,item_name,quantity,unit_price,total_price)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (order_number, order_date, item_key, product_id, item_name, qty, unit_price, total_price),
        )
        existing.add((order_number, item_key))
        imported += 1

    db.commit()
    db.close()
    return {"imported": imported, "skipped": skipped, "errors": errors}


# --- Reports ---

@app.get("/api/reports/summary")
def report_summary():
    db = get_db()
    total_products = db.execute(
        "SELECT COUNT(*) FROM products WHERE discontinued IS NULL OR discontinued = 0"
    ).fetchone()[0]
    low_stock_count = db.execute(
        "SELECT COUNT(*) FROM products WHERE stock <= reorder_point AND reorder_point > 0 AND (discontinued IS NULL OR discontinued = 0)"
    ).fetchone()[0]
    plan_qty = db.execute("SELECT COALESCE(SUM(quantity),0) FROM order_plan_items").fetchone()[0]
    order_qty = db.execute("SELECT COALESCE(SUM(quantity),0) FROM orders WHERE status IN ('pending','ordered')").fetchone()[0]
    receipt_qty = db.execute("SELECT COALESCE(SUM(quantity),0) FROM receipt_items").fetchone()[0]
    pending_orders = max(0, plan_qty + order_qty - receipt_qty)
    total_received = db.execute("SELECT COALESCE(SUM(quantity),0) FROM receipt_items").fetchone()[0]
    db.close()
    return {
        "total_products": total_products,
        "low_stock_count": low_stock_count,
        "pending_orders": pending_orders,
        "recent_in": total_received,
    }

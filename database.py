import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "inventory.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            variation TEXT DEFAULT '',
            factory TEXT DEFAULT '',
            purchase_name TEXT DEFAULT '',
            eishin TEXT DEFAULT '',
            nf_sku TEXT DEFAULT '',
            sku TEXT DEFAULT '',
            barcode TEXT DEFAULT '',
            amazon_url TEXT DEFAULT '',
            cost_price REAL DEFAULT 0,
            selling_price REAL DEFAULT 0,
            stock INTEGER DEFAULT 0,
            reorder_point INTEGER DEFAULT 0,
            monthly_sales INTEGER DEFAULT 0,
            sessions INTEGER DEFAULT 0,
            order_count INTEGER DEFAULT 0,
            amazon_stock INTEGER DEFAULT 0,
            yahoo_stock INTEGER DEFAULT 0,
            rakuten_stock INTEGER DEFAULT 0,
            mercari_stock INTEGER DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            contact_person TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            date DATE DEFAULT CURRENT_DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            supplier_id INTEGER,
            quantity INTEGER NOT NULL,
            unit_price REAL DEFAULT 0,
            order_date DATE DEFAULT CURRENT_DATE,
            expected_delivery DATE,
            status TEXT DEFAULT 'pending',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS order_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_date DATE NOT NULL,
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_plan_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            product_id INTEGER,
            sku TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            FOREIGN KEY (plan_id) REFERENCES order_plans(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_date DATE NOT NULL,
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS receipt_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id INTEGER NOT NULL,
            product_id INTEGER,
            sku TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS rakuten_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_number TEXT DEFAULT '',
            order_date TEXT DEFAULT '',
            item_number TEXT DEFAULT '',
            product_id INTEGER,
            item_name TEXT DEFAULT '',
            quantity INTEGER DEFAULT 0,
            unit_price REAL DEFAULT 0,
            total_price REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TRIGGER IF NOT EXISTS update_product_timestamp
        AFTER UPDATE ON products
        BEGIN
            UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
    """)
    conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('lead_time_months', '1.5')")
    conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('target_stock_months', '2.0')")
    conn.commit()

    # マイグレーション: 既存DBにカラムがない場合は追加
    cols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
    if "sessions" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN sessions INTEGER DEFAULT 0")
        conn.commit()
    if "order_count" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN order_count INTEGER DEFAULT 0")
        conn.commit()
    for col in ("amazon_stock", "yahoo_stock", "rakuten_stock", "mercari_stock"):
        if col not in cols:
            conn.execute(f"ALTER TABLE products ADD COLUMN {col} INTEGER DEFAULT 0")
            conn.commit()
    if "discontinued" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN discontinued INTEGER DEFAULT 0")
        conn.commit()
    if "manual_pending" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN manual_pending INTEGER DEFAULT NULL")
        conn.commit()
    if "rakuten_item_number" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN rakuten_item_number TEXT DEFAULT ''")
        conn.commit()
    if "rakuten_price" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN rakuten_price REAL DEFAULT 0")
        conn.commit()
    if "sale_start_date" not in cols:
        conn.execute("ALTER TABLE products ADD COLUMN sale_start_date TEXT DEFAULT ''")
        conn.commit()
    for col, definition in [
        ("selmon_registered",      "TEXT DEFAULT ''"),
        ("selmon_review",          "TEXT DEFAULT ''"),
        ("selmon_review_comment",  "TEXT DEFAULT ''"),
        ("selmon_sales_7d",        "INTEGER DEFAULT 0"),
        ("selmon_sales_30d",       "INTEGER DEFAULT 0"),
        ("selmon_sales_60d",       "INTEGER DEFAULT 0"),
        ("selmon_sales_90d",       "INTEGER DEFAULT 0"),
        ("yahoo_item_number", "TEXT DEFAULT ''"),
        ("yahoo_price",       "REAL DEFAULT 0"),
        ("yahoo_monthly_sales",   "INTEGER DEFAULT 0"),
        ("yahoo_monthly_revenue", "REAL DEFAULT 0"),
        ("yahoo_page_views",      "INTEGER DEFAULT 0"),
        ("yahoo_visitors",        "INTEGER DEFAULT 0"),
    ]:
        if col not in cols:
            conn.execute(f"ALTER TABLE products ADD COLUMN {col} {definition}")
            conn.commit()

    conn.close()

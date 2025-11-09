const express = require("express");
const app = express();
require("dotenv").config();

const port = process.env.PORT || 3000;
app.use(express.json());

const { pool, ping } = require("./connection");

// Salud
app.get("/ping", async (_req, res) => {
  try {
    const ok = await ping();
    res.json({ db: ok });
  } catch (e) {
    res.status(500).json({ db: false, error: e.message });
  }
});

// Página
app.get("/", (_req, res) =>
  res.send("API de productos funcionando correctamente")
);

// PRODUCTS (ya los tenías)
app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Error al obtener productos" });
  }
});
app.post("/api/products", async (req, res) => {
  try {
    const { name, description, price, stock, image } = req.body;
    if (!name || price === undefined || stock === undefined) {
      return res
        .status(400)
        .json({ error: "Los campos name, price y stock son obligatorios" });
    }
    const [r] = await pool.query(
      "INSERT INTO products (name, description, price, stock, image, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
      [name, description || null, price, stock, image || null]
    );
    const [rows] = await pool.query("SELECT * FROM products WHERE id=?", [
      r.insertId,
    ]);
    res
      .status(201)
      .json({ message: "Producto creado correctamente", producto: rows[0] });
  } catch (e) {
    res.status(500).json({ error: "Error al crear producto" });
  }
});
app.put("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, description, price, stock, image } = req.body;
    const [r] = await pool.query(
      "UPDATE products SET name=?, description=?, price=?, stock=?, image=? WHERE id=?",
      [name, description, price, stock, image, id]
    );
    if (!r.affectedRows)
      return res.status(404).json({ error: "Producto no encontrado" });
    const [rows] = await pool.query("SELECT * FROM products WHERE id=?", [id]);
    res.json({
      message: "Producto actualizado correctamente",
      producto: rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: "Error al actualizar producto" });
  }
});

// ====== PURCHASES (solo POST) ======
app.post("/api/purchases", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { user_id, status, details } = body;
    if (!user_id || !status || !Array.isArray(details)) {
      conn.release();
      return res
        .status(400)
        .json({ error: "user_id, status y details son obligatorios" });
    }
    if (details.length < 1 || details.length > 5) {
      conn.release();
      return res
        .status(400)
        .json({ error: "La compra debe tener entre 1 y 5 productos" });
    }

    await conn.beginTransaction();
    let total = 0;

    for (const d of details) {
      if (!d.product_id || !d.quantity || d.price === undefined) {
        throw new Error("Cada detalle requiere product_id, quantity y price");
      }
      if (d.quantity <= 0) throw new Error("quantity debe ser > 0");
      const [[prod]] = await conn.query(
        "SELECT id, stock FROM products WHERE id=? FOR UPDATE",
        [d.product_id]
      );
      if (!prod) throw new Error(`Producto ${d.product_id} no existe`);
      if (prod.stock < d.quantity)
        throw new Error(`Stock insuficiente para producto ${d.product_id}`);
      total += Number(d.price) * Number(d.quantity);
    }
    if (total > 3500) throw new Error("El total no puede superar 3500");

    const [pRes] = await conn.query(
      "INSERT INTO purchases (user_id, total, status, purchase_date) VALUES (?, ?, ?, NOW())",
      [user_id, total, status]
    );
    const purchaseId = pRes.insertId;

    for (const d of details) {
      const subtotal = Number(d.price) * Number(d.quantity);
      await conn.query(
        "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
        [purchaseId, d.product_id, d.quantity, d.price, subtotal]
      );
      await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
        d.quantity,
        d.product_id,
      ]);
    }

    await conn.commit();

    const [[purchase]] = await conn.query(
      "SELECT * FROM purchases WHERE id=?",
      [purchaseId]
    );
    const [det] = await conn.query(
      "SELECT id, product_id, quantity, price, subtotal FROM purchase_details WHERE purchase_id=? ORDER BY id",
      [purchaseId]
    );

    res.status(201).json({
      id: purchase.id,
      user_id: purchase.user_id,
      total: purchase.total,
      status: purchase.status,
      purchase_date: purchase.purchase_date,
      details: det,
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(400).json({ error: err.message || "Error al crear la compra" });
  } finally {
    try {
      conn.release();
    } catch {}
  }
});

app.get("/__debug__/routes", (_req, res) => {
  const getRoutes = (app) =>
    app._router.stack
      .filter((r) => r.route)
      .map((r) => ({
        methods: Object.keys(r.route.methods),
        path: r.route.path,
      }));
  res.json(getRoutes(app));
});

app.use((req, res) => {
  res
    .status(404)
    .json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

app.put("/api/purchases/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { user_id, status, details } = body || {};

    await conn.beginTransaction();

    const [[purchase]] = await conn.query(
      "SELECT id, status FROM purchases WHERE id=? FOR UPDATE",
      [id]
    );
    if (!purchase) throw new Error("Compra no encontrada");
    if (purchase.status === "COMPLETED")
      throw new Error("No se puede modificar una compra COMPLETED");

    if (details) {
      if (!Array.isArray(details) || details.length < 1 || details.length > 5) {
        throw new Error("La compra debe tener entre 1 y 5 productos");
      }
      for (const d of details) {
        if (!d.product_id || d.quantity == null || d.price == null) {
          throw new Error("Cada detalle requiere product_id, quantity y price");
        }
        if (!Number.isInteger(d.quantity) || d.quantity <= 0) {
          throw new Error("quantity debe ser un entero > 0");
        }
        if (!Number.isFinite(Number(d.price)))
          throw new Error("price inválido");
      }
    }

    const [oldDet] = await conn.query(
      "SELECT product_id, quantity FROM purchase_details WHERE purchase_id=? FOR UPDATE",
      [id]
    );
    for (const d of oldDet) {
      await conn.query("UPDATE products SET stock = stock + ? WHERE id = ?", [
        d.quantity,
        d.product_id,
      ]);
    }
    await conn.query("DELETE FROM purchase_details WHERE purchase_id=?", [id]);

    let newTotal = 0;
    if (details) {
      for (const d of details) {
        const [[prod]] = await conn.query(
          "SELECT id, stock FROM products WHERE id=? FOR UPDATE",
          [d.product_id]
        );
        if (!prod) throw new Error(`Producto ${d.product_id} no existe`);
        if (prod.stock < d.quantity)
          throw new Error(`Stock insuficiente para producto ${d.product_id}`);
        const subtotal = Number(d.price) * Number(d.quantity);
        newTotal += subtotal;

        await conn.query(
          "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
          [id, d.product_id, d.quantity, d.price, subtotal]
        );
        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
          d.quantity,
          d.product_id,
        ]);
      }
    } else {
      const [[p]] = await conn.query("SELECT total FROM purchases WHERE id=?", [
        id,
      ]);
      newTotal = Number(p.total);
    }

    if (newTotal > 3500) throw new Error("El total no puede superar 3500");

    await conn.query(
      "UPDATE purchases SET user_id = COALESCE(?, user_id), total=?, status=?, updated_at=NOW() WHERE id=?",
      [user_id ?? null, newTotal, status ?? purchase.status, id]
    );

    await conn.commit();
    res.json({
      ok: true,
      id,
      total: newTotal,
      status: status ?? purchase.status,
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res
      .status(400)
      .json({ error: err.message || "Error al actualizar la compra" });
  } finally {
    try {
      conn.release();
    } catch {}
  }
});

app.delete("/api/purchases/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    await conn.beginTransaction();

    const [[p]] = await conn.query(
      "SELECT id, status FROM purchases WHERE id=? FOR UPDATE",
      [id]
    );
    if (!p) throw new Error("Compra no encontrada");
    if (p.status === "COMPLETED")
      throw new Error("No se puede borrar una compra COMPLETED");

    const [det] = await conn.query(
      "SELECT product_id, quantity FROM purchase_details WHERE purchase_id=? FOR UPDATE",
      [id]
    );
    for (const d of det) {
      await conn.query("UPDATE products SET stock = stock + ? WHERE id = ?", [
        d.quantity,
        d.product_id,
      ]);
    }

    await conn.query("DELETE FROM purchase_details WHERE purchase_id=?", [id]);
    await conn.query("DELETE FROM purchases WHERE id=?", [id]);

    await conn.commit();
    res.json({ ok: true, message: "Compra eliminada y stock restaurado" });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res
      .status(400)
      .json({ error: err.message || "Error al eliminar la compra" });
  } finally {
    try {
      conn.release();
    } catch {}
  }
});

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
  console.log("Rutas disponibles:");
  console.log(`GET     -> /api/products`);
  console.log(`POST    -> /api/products`);
  console.log(`PUT     -> /api/products/:id`);
  console.log(`POST    -> /api/purchases`);
  console.log(`GET  -> /__debug__/routes`);
  console.log(`PUT  -> /api/purchases/:id`);
  console.log(`DELETE -> /api/purchases/:id`);
});

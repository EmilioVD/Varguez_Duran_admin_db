const express = require("express");
const app = express();
require("dotenv").config();

const port = process.env.PORT || 3000;
app.use(express.json());

const { pool, ping } = require("./connection");

app.get("/ping", async (_req, res) => {
  try {
    const ok = await ping();
    res.json({ db: ok });
  } catch (error) {
    res.status(500).json({ db: false, error: error.message });
  }
});

// Ruta principal
app.get("/", (_req, res) =>
  res.send("API de productos funcionando correctamente")
);

// GET: obtener productos
app.get("/api/products", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    console.error("Error en GET /api/products", error);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

// POST: crear un nuevo producto
app.post("/api/products", async (req, res) => {
  try {
    const { name, description, price, stock, image } = req.body;

    if (!name || price === undefined || stock === undefined) {
      return res
        .status(400)
        .json({ error: "Los campos name, price y stock son obligatorios" });
    }

    const [result] = await pool.query(
      "INSERT INTO products (name, description, price, stock, image, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
      [name, description || null, price, stock, image || null]
    );

    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [
      result.insertId,
    ]);

    res.status(201).json({
      message: "Producto creado correctamente",
      producto: rows[0],
    });
  } catch (error) {
    console.error("Error en POST /api/products", error);
    res.status(500).json({ error: "Error al crear producto" });
  }
});

// PUT: actualizar un producto existente
app.put("/api/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, description, price, stock, image } = req.body;

    if (!id) {
      return res.status(400).json({ error: "ID inválido o faltante" });
    }

    const [result] = await pool.query(
      "UPDATE products SET name=?, description=?, price=?, stock=?, image=? WHERE id=?",
      [name, description, price, stock, image, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [
      id,
    ]);

    res.json({
      message: "Producto actualizado correctamente",
      producto: rows[0],
    });
  } catch (error) {
    console.error("Error en PUT /api/products/:id", error);
    res.status(500).json({ error: "Error al actualizar producto" });
  }
});

function mapPurchases(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.p_id)) {
      map.set(r.p_id, {
        id: r.p_id,
        user: r.user_name || null,
        total: Number(r.total),
        status: r.status,
        purchase_date: r.purchase_date,
        details: [],
      });
    }
    if (r.d_id) {
      map.get(r.p_id).details.push({
        id: r.d_id,
        product: r.product_name,
        quantity: r.quantity,
        price: Number(r.price),
        subtotal: Number(r.subtotal),
      });
    }
  }
  return Array.from(map.values());
}

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
      if (d.quantity <= 0) {
        throw new Error("quantity debe ser > 0");
      }

      const [[prod]] = await conn.query(
        "SELECT id, stock FROM products WHERE id = ? FOR UPDATE",
        [d.product_id]
      );
      if (!prod) throw new Error(`Producto ${d.product_id} no existe`);
      if (prod.stock < d.quantity)
        throw new Error(`Stock insuficiente para producto ${d.product_id}`);

      total += Number(d.price) * Number(d.quantity);
    }

    if (total > 3500) {
      throw new Error("El total no puede superar 3500");
    }

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
      "SELECT * FROM purchases WHERE id = ?",
      [purchaseId]
    );
    const [det] = await conn.query(
      `SELECT pd.id, pd.product_id, pd.quantity, pd.price, pd.subtotal
       FROM purchase_details pd WHERE pd.purchase_id = ? ORDER BY pd.id`,
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
    } catch (_) {}
    console.error("POST /api/purchases ->", err.code || "", err.message);
    res.status(400).json({ error: err.message || "Error al crear la compra" });
  } finally {
    try {
      conn.release();
    } catch (_) {}
  }
});

app.get("/api/purchases", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        p.id AS p_id, u.name AS user_name, p.total, p.status, p.purchase_date,
        pd.id AS d_id, pr.name AS product_name, pd.quantity, pd.price, pd.subtotal
      FROM purchases p
      LEFT JOIN users u             ON u.id = p.user_id
      LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
      LEFT JOIN products pr         ON pr.id = pd.product_id
      ORDER BY p.id DESC, pd.id ASC
    `);
    res.json(mapPurchases(rows));
  } catch (err) {
    console.error("GET /api/purchases ->", err);
    res.status(500).json({ error: "Error al obtener compras" });
  }
});

// GET: compra por id con JOINs
app.get("/api/purchases/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `
      SELECT 
        p.id AS p_id, u.name AS user_name, p.total, p.status, p.purchase_date,
        pd.id AS d_id, pr.name AS product_name, pd.quantity, pd.price, pd.subtotal
      FROM purchases p
      LEFT JOIN users u             ON u.id = p.user_id
      LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
      LEFT JOIN products pr         ON pr.id = pd.product_id
      WHERE p.id = ?
      ORDER BY pd.id ASC
    `,
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ error: "Compra no encontrada" });
    res.json(mapPurchases(rows)[0]);
  } catch (err) {
    console.error("GET /api/purchases/:id ->", err);
    res.status(500).json({ error: "Error al obtener la compra" });
  }
});

// PUT: actualizar compra (reglas + ajuste de stock)
app.put("/api/purchases/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { user_id, status, details } = body || {};

    await conn.beginTransaction();

    // Bloquea encabezado
    const [[purchase]] = await conn.query(
      "SELECT id, status FROM purchases WHERE id=? FOR UPDATE",
      [id]
    );
    if (!purchase) throw new Error("Compra no encontrada");
    if (purchase.status === "COMPLETED") {
      throw new Error("No se puede modificar una compra COMPLETED");
    }

    // Validaciones básicas
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
        if (!Number.isFinite(Number(d.price))) {
          throw new Error("price inválido");
        }
      }
    }

    // Obtener detalles actuales y regresarlos al stock
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

    // Insertar nuevos detalles y descontar stock
    let newTotal = 0;
    if (details) {
      for (const d of details) {
        const [[prod]] = await conn.query(
          "SELECT id, stock FROM products WHERE id=? FOR UPDATE",
          [d.product_id]
        );
        if (!prod) throw new Error(`Producto ${d.product_id} no existe`);
        if (prod.stock < d.quantity) {
          throw new Error(`Stock insuficiente para producto ${d.product_id}`);
        }
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

    const nextStatus = status ?? purchase.status;
    await conn.query(
      "UPDATE purchases SET user_id = COALESCE(?, user_id), total=?, status=?, updated_at=NOW() WHERE id=?",
      [user_id ?? null, newTotal, nextStatus, id]
    );

    await conn.commit();

    const [rows] = await conn.query(
      `
      SELECT 
        p.id AS p_id, u.name AS user_name, p.total, p.status, p.purchase_date,
        pd.id AS d_id, pr.name AS product_name, pd.quantity, pd.price, pd.subtotal
      FROM purchases p
      LEFT JOIN users u             ON u.id = p.user_id
      LEFT JOIN purchase_details pd ON pd.purchase_id = p.id
      LEFT JOIN products pr         ON pr.id = pd.product_id
      WHERE p.id = ?
      ORDER BY pd.id ASC
    `,
      [id]
    );
    res.json(mapPurchases(rows)[0]);
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    console.error("PUT /api/purchases/:id ->", err.message);
    res
      .status(400)
      .json({ error: err.message || "Error al actualizar la compra" });
  } finally {
    try {
      conn.release();
    } catch (_) {}
  }
});

// DELETE: eliminar compra (si NO está COMPLETED) y restaurar stock
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
    if (p.status === "COMPLETED") {
      throw new Error("No se puede borrar una compra COMPLETED");
    }

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
    } catch (_) {}
    console.error("DELETE /api/purchases/:id ->", err.message);
    res
      .status(400)
      .json({ error: err.message || "Error al eliminar la compra" });
  } finally {
    try {
      conn.release();
    } catch (_) {}
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
  console.log("Rutas disponibles:");
  console.log(`GET     -> /api/products`);
  console.log(`POST    -> /api/products`);
  console.log(`PUT     -> /api/products/:id`);
  console.log(`POST    -> /api/purchases`);
  console.log(`GET     -> /api/purchases`);
  console.log(`GET     -> /api/purchases/:id`);
  console.log(`PUT     -> /api/purchases/:id`);
  console.log(`DELETE  -> /api/purchases/:id`);
});

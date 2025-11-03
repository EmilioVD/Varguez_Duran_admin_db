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

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
  console.log("Rutas disponibles:");
  console.log(`GET  -> /api/products`);
  console.log(`POST -> /api/products`);
  console.log(`PUT  -> /api/products/:id`);
});

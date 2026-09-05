 const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: __dirname + "/.env" });

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ===============================
// DATABASE INITIALIZATION
// ===============================

async function initializeDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            phone VARCHAR(20) NOT NULL UNIQUE,
            city VARCHAR(100),
            address TEXT,
            role ENUM('farmer','consumer') NOT NULL,
            kyc_verified BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS products (
            id INT AUTO_INCREMENT PRIMARY KEY,
            farmer_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            category VARCHAR(100),
            price DECIMAL(10,2) NOT NULL,
            quantity DECIMAL(10,2) NOT NULL,
            listing_date DATE,
            shelf_days INT DEFAULT 14,
            photo LONGTEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (farmer_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_number VARCHAR(50) NOT NULL UNIQUE,
            consumer_id INT NOT NULL,
            farmer_id INT NOT NULL,
            total_amount DECIMAL(10,2) NOT NULL,
            status VARCHAR(50) DEFAULT 'Order placed',
            eta VARCHAR(50) DEFAULT 'Preparing',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (consumer_id) REFERENCES users(id)
                ON DELETE CASCADE,
            FOREIGN KEY (farmer_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            product_id INT NOT NULL,
            quantity DECIMAL(10,2) NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id)
                ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
                ON DELETE CASCADE
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            message TEXT NOT NULL,
            order_id INT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    console.log("✅ Database tables ready");
}

// ===============================
// BASIC ROUTES
// ===============================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "AgriSetu Backend is running 🌾"
    });
});

app.get("/api/health", async (req, res) => {
    try {
        await db.query("SELECT 1");

        res.json({
            success: true,
            message: "Backend + MySQL connected successfully",
            database: process.env.DB_NAME,
            mysql: true
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "MySQL connection failed",
            error: error.message
        });
    }
});

// ===============================
// USER / SIGNUP
// ===============================

app.post("/api/users", async (req, res) => {
    try {
        const {
            name,
            phone,
            city,
            address,
            role,
            kycVerified
        } = req.body;

        if (!name || !phone || !role) {
            return res.status(400).json({
                success: false,
                message: "Name, phone and role are required"
            });
        }

        const [existing] = await db.query(
            "SELECT * FROM users WHERE phone = ? AND role = ?",
            [phone, role]
        );

        if (existing.length > 0) {
            return res.json({
                success: true,
                user: existing[0],
                existing: true
            });
        }

        const [result] = await db.query(
            `INSERT INTO users
            (name, phone, city, address, role, kyc_verified)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                name,
                phone,
                city || null,
                address || null,
                role,
                kycVerified ? 1 : 0
            ]
        );

        const [rows] = await db.query(
            "SELECT * FROM users WHERE id = ?",
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            user: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "User creation failed",
            error: error.message
        });
    }
});

// ===============================
// LOGIN
// ===============================

app.post("/api/login", async (req, res) => {
    try {
        const { phone, role } = req.body;

        const [rows] = await db.query(
            "SELECT * FROM users WHERE phone = ? AND role = ?",
            [phone, role]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No account found"
            });
        }

        res.json({
            success: true,
            user: rows[0]
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Login failed",
            error: error.message
        });
    }
});

// ===============================
// FARMER - PUBLISH PRODUCT
// ===============================

app.post("/api/products", async (req, res) => {
    try {
        const {
            farmerId,
            name,
            category,
            price,
            quantity,
            listingDate,
            shelfDays,
            photo
        } = req.body;

        if (
            !farmerId ||
            !name ||
            !price ||
            !quantity
        ) {
            return res.status(400).json({
                success: false,
                message: "Farmer, product, price and quantity are required"
            });
        }

        const [farmer] = await db.query(
            "SELECT id FROM users WHERE id = ? AND role = 'farmer'",
            [farmerId]
        );

        if (farmer.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Farmer not found"
            });
        }

        const [result] = await db.query(
            `INSERT INTO products
            (farmer_id, name, category, price, quantity, listing_date, shelf_days, photo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                farmerId,
                name,
                category || "Vegetable",
                price,
                quantity,
                listingDate || new Date(),
                shelfDays || 14,
                photo || null
            ]
        );

        const [rows] = await db.query(`
            SELECT
                p.*,
                u.name AS farmer_name,
                u.city AS farmer_city
            FROM products p
            JOIN users u ON p.farmer_id = u.id
            WHERE p.id = ?
        `, [result.insertId]);

        res.status(201).json({
            success: true,
            message: "Product published successfully",
            product: rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Product publishing failed",
            error: error.message
        });
    }
});

// ===============================
// CONSUMER - GET PRODUCTS
// ===============================

app.get("/api/products", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                p.id,
                p.farmer_id,
                p.name,
                p.category,
                p.price,
                p.quantity,
                p.listing_date,
                p.shelf_days,
                p.photo,
                u.name AS farmer_name,
                u.city AS farmer_city,
                u.kyc_verified
            FROM products p
            JOIN users u ON p.farmer_id = u.id
            WHERE p.quantity > 0
            ORDER BY p.created_at DESC
        `);

        res.json({
            success: true,
            products: rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Products could not be loaded",
            error: error.message
        });
    }
});

// ===============================
// FARMER - MY PRODUCTS
// ===============================

app.get("/api/products/farmer/:farmerId", async (req, res) => {
    try {
        const { farmerId } = req.params;

        const [rows] = await db.query(
            `SELECT * FROM products
             WHERE farmer_id = ?
             ORDER BY created_at DESC`,
            [farmerId]
        );

        res.json({
            success: true,
            products: rows
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Farmer products could not be loaded",
            error: error.message
        });
    }
});

// ===============================
// DELETE PRODUCT
// ===============================

app.delete("/api/products/:id", async (req, res) => {
    try {
        const { id } = req.params;

        await db.query(
            "DELETE FROM products WHERE id = ?",
            [id]
        );

        res.json({
            success: true,
            message: "Product deleted successfully"
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Product deletion failed",
            error: error.message
        });
    }
});

// ===============================
// START SERVER
// ===============================

async function startServer() {
    try {
        await initializeDatabase();

        const PORT = process.env.PORT || 5000;

        app.listen(PORT, () => {
            console.log(`🌾 AgriSetu Backend running on http://localhost:${PORT}`);
        });

    } catch (error) {
        console.error("❌ Server startup failed:", error.message);
    }
}

startServer();
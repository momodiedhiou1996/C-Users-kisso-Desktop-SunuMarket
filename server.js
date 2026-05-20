require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const PDFDocument = require("pdfkit");
const Stripe = require("stripe");
const { v4: uuid } = require("uuid");

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET;
const WAVE_PAYMENT_URL = process.env.WAVE_PAYMENT_URL || "https://pay.wave.com/m/M_sn_JisvoWc3PyZN/c/sn/";
const WAVE_WEBHOOK_SECRET = process.env.WAVE_WEBHOOK_SECRET || "";
const WAVE_WEBHOOK_SIGNATURE_HEADER = (process.env.WAVE_WEBHOOK_SIGNATURE_HEADER || "x-wave-signature").toLowerCase();
const LEGACY_DATA_PATH = path.resolve(__dirname, "data.json");
const DATABASE_PATH = process.env.DATABASE_PATH || path.resolve(__dirname, "sunumarket.db");
const BCRYPT_ROUNDS = 12;
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX || 25);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 300);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET manquant ou trop court. Définissez une valeur forte d'au moins 32 caractères.");
}

const allowedOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
  throw new Error("FRONTEND_ORIGINS est requis en production.");
}

const devFallbackOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const effectiveAllowedOrigins = allowedOrigins.length > 0 ? allowedOrigins : devFallbackOrigins;

function corsOriginValidator(origin, callback) {
  // Allow tools without Origin header (curl, Postman, server-to-server).
  if (!origin) {
    callback(null, true);
    return;
  }

  if (effectiveAllowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error("Origin non autorisee par CORS"));
}

const app = express();
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cors({
  origin: corsOriginValidator,
  credentials: true,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Trop de requetes. Reessayez plus tard." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Trop de tentatives de connexion. Reessayez plus tard." },
});

app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

function ensureDataShape(data) {
  if (!data || typeof data !== "object") return { users: [], payments: [], processedWebhookEvents: [] };
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.payments)) data.payments = [];
  if (!Array.isArray(data.processedWebhookEvents)) data.processedWebhookEvents = [];
  return data;
}

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.prepare(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`).run();

function getInitialState() {
  if (fs.existsSync(LEGACY_DATA_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_DATA_PATH, "utf-8");
      return ensureDataShape(JSON.parse(raw));
    } catch (err) {
      console.error("Failed to migrate legacy data.json", err);
    }
  }
  return ensureDataShape({ users: [], payments: [], processedWebhookEvents: [] });
}

function initializeStorage() {
  const existing = db.prepare("SELECT id FROM app_state WHERE id = 1").get();
  if (existing) return;

  const initialState = getInitialState();
  db.prepare("INSERT INTO app_state (id, state, updated_at) VALUES (1, ?, ?)").run(
    JSON.stringify(initialState),
    Date.now(),
  );
}

initializeStorage();

function loadData() {
  try {
    const row = db.prepare("SELECT state FROM app_state WHERE id = 1").get();
    if (!row || !row.state) {
      const fallback = ensureDataShape({ users: [], payments: [], processedWebhookEvents: [] });
      saveData(fallback);
      return fallback;
    }
    return ensureDataShape(JSON.parse(row.state));
  } catch (err) {
    console.error("Failed to load SQLite state", err);
    return { users: [], payments: [], processedWebhookEvents: [] };
  }
}

function saveData(data) {
  const state = JSON.stringify(ensureDataShape(data));
  db.prepare(`
    INSERT INTO app_state (id, state, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at
  `).run(state, Date.now());
}

function normalizePaymentStatus(statusRaw, eventType = "") {
  const status = String(statusRaw || "").toLowerCase();
  const event = String(eventType || "").toLowerCase();

  if ([status, event].some((v) => v.includes("success") || v.includes("succeeded") || v.includes("completed") || v.includes("paid"))) {
    return "paid";
  }
  if ([status, event].some((v) => v.includes("pending") || v.includes("processing") || v.includes("created") || v.includes("initiated"))) {
    return "pending";
  }
  if ([status, event].some((v) => v.includes("fail") || v.includes("cancel") || v.includes("declin") || v.includes("expired") || v.includes("rejected"))) {
    return "failed";
  }
  return "unknown";
}

function sanitizeSignature(rawSignature) {
  if (!rawSignature) return "";
  const value = String(rawSignature).trim();
  if (value.startsWith("sha256=")) return value.slice(7).toLowerCase();
  return value.toLowerCase();
}

function verifyWaveWebhookSignature(req) {
  if (!WAVE_WEBHOOK_SECRET) {
    return true;
  }

  const signature = sanitizeSignature(req.headers[WAVE_WEBHOOK_SIGNATURE_HEADER]);
  if (!signature) return false;

  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), "utf-8");
  const expected = crypto.createHmac("sha256", WAVE_WEBHOOK_SECRET).update(rawBody).digest("hex");

  const a = Buffer.from(signature, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizePhoneNumber(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^0-9+]/g, "").replace(/^\+/, "");
}

function getSellerWhatsAppNumber(seller) {
  if (!seller) return null;
  const raw = seller.socialLinks?.whatsapp || seller.phone;
  const normalized = normalizePhoneNumber(raw);
  return normalized || null;
}

async function sendWhatsAppNotification(seller, order, product) {
  const number = getSellerWhatsAppNumber(seller);
  if (!number) return;

  const message = `Nouvelle commande : ${order.quantity} x ${product.name} pour ${order.customer.firstName} ${order.customer.lastName}. Total ${order.total} FCFA. Livraison : ${order.customer.address}. Contact client : ${order.customer.phone}. Méthode : ${order.paymentMethod}.`;

  if (process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN) {
    try {
      await axios.post(process.env.WHATSAPP_API_URL, {
        to: number,
        text: message,
      }, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      });
      console.log(`WhatsApp notification envoyée à ${number}`);
      return;
    } catch (err) {
      console.error("Échec de l'envoi WhatsApp", err.message || err);
    }
  }

  console.log("--- WhatsApp notification ---");
  console.log(`À: ${number}`);
  console.log(`Message: ${message}`);
  console.log(`Lien direct: https://wa.me/${number}?text=${encodeURIComponent(message)}`);
  console.log("--- Fin notification ---");
}

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token manquant" });
  }
  const token = header.replace("Bearer ", "");
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ message: "Token invalide" });
  }
  const data = loadData();
  const user = data.users.find((u) => u.id === payload.id);
  if (!user) return res.status(401).json({ message: "Utilisateur introuvable" });
  req.user = user;
  req.data = data;
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, phone, email, password, socialLinks = {}, accountType = "seller", storeName, storeLogo, subscriptionPaid = false, subscriptionMethod, subscriptionTransactionId } = req.body;
  if (!name || !phone || !email || !password || !["seller", "customer"].includes(accountType)) {
    return res.status(400).json({ message: "Champs manquants ou type de compte invalide" });
  }
  if (accountType === "seller") {
    if (!storeName) {
      return res.status(400).json({ message: "Nom de boutique requis pour le compte vendeur" });
    }
  }

  const data = loadData();
  const existing = data.users.find((u) => u.email === email.toLowerCase() || u.phone === phone);
  if (existing) {
    return res.status(400).json({ message: "Un compte existe déjà avec cet email ou téléphone" });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = {
    id: uuid(),
    name: name.trim(),
    phone: phone.trim(),
    email: email.trim().toLowerCase(),
    password: passwordHash,
    accountType,
    socialLinks: socialLinks,
    notifications: [],
    emailVerified: true,
    emailVerificationToken: null,
    subscriptionPaid: accountType === "seller" ? !!subscriptionPaid : false,
    subscriptionMethod: accountType === "seller" ? (subscriptionMethod || null) : null,
    subscriptionTransactionId: accountType === "seller" ? (subscriptionTransactionId || null) : null,
    store: accountType === "seller" ? {
      name: storeName.trim(),
      description: "",
      slug: storeName.replace(/\s+/g, "").toLowerCase(),
      logo: storeLogo || "",
      products: [],
      orders: [],
      goal: 0,
      sales: 0,
      customers: [],
      themeColor: "#28a745",
      createdAt: Date.now(),
    } : null,
  };

  if (!user.socialLinks.whatsapp) {
    const cleanedPhone = user.phone.replace(/[^0-9]/g, '');
    user.socialLinks.whatsapp = `https://wa.me/${cleanedPhone}`;
  }

  data.users.push(user);

  saveData(data);

  const token = createToken({ id: user.id });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, accountType: user.accountType, emailVerified: true } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "Email et mot de passe requis" });
  }

  const data = loadData();
  const user = data.users.find((u) => u.email === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ message: "Email ou mot de passe incorrect" });
  }

  let passwordMatches = false;

  if (typeof user.password === "string" && user.password.startsWith("$2")) {
    passwordMatches = await bcrypt.compare(password, user.password);
  } else {
    // One-time migration path for legacy plain-text passwords.
    passwordMatches = user.password === password;
    if (passwordMatches) {
      user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
      saveData(data);
    }
  }

  if (!passwordMatches) {
    return res.status(401).json({ message: "Email ou mot de passe incorrect" });
  }

  const token = createToken({ id: user.id });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, accountType: user.accountType, emailVerified: true } });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const { user } = req;
  if (user.emailVerified !== true) {
    user.emailVerified = true;
    user.emailVerificationToken = null;
    saveData(req.data);
  }
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      accountType: user.accountType,
      emailVerified: user.emailVerified,
      socialLinks: user.socialLinks,
      notifications: user.notifications || [],
    },
    store: user.store,
  });
});

app.put("/api/me", authMiddleware, async (req, res) => {
  const { user: updates } = req.body;
  if (!updates) return res.status(400).json({ message: "Mises à jour requises" });

  const data = req.data;
  const user = req.user;

  if (updates.name) user.name = updates.name.trim();
  if (updates.phone) user.phone = updates.phone.trim();
  if (updates.email) {
    const existing = data.users.find((u) => u.email === updates.email.toLowerCase() && u.id !== user.id);
    if (existing) return res.status(400).json({ message: "Email déjà utilisé" });
    user.email = updates.email.trim().toLowerCase();
  }
  if (updates.password) user.password = await bcrypt.hash(updates.password, BCRYPT_ROUNDS);
  if (updates.socialLinks) user.socialLinks = updates.socialLinks;

  // Ensure WhatsApp is connected to phone number
  if (!user.socialLinks.whatsapp) {
    const cleanedPhone = user.phone.replace(/[^0-9]/g, '');
    user.socialLinks.whatsapp = `https://wa.me/${cleanedPhone}`;
  }

  saveData(data);
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      socialLinks: user.socialLinks,
      accountType: user.accountType,
      notifications: user.notifications || [],
    },
    store: user.store,
  });
});

app.delete("/api/me", authMiddleware, (req, res) => {
  const data = req.data;
  const user = req.user;
  data.users = data.users.filter((u) => u.id !== user.id);
  saveData(data);
  res.json({ ok: true });
});

app.put("/api/me/store", authMiddleware, (req, res) => {
  const { name, description, themeColor } = req.body;
  if (!name) return res.status(400).json({ message: "Nom de boutique requis" });

  const data = req.data;
  const user = req.user;
  user.store.name = name;
  user.store.description = description || "";
  user.store.slug = name.replace(/\s+/g, "").toLowerCase();
  if (themeColor) user.store.themeColor = themeColor;
  saveData(data);

  res.json({ store: user.store });
});

app.get("/api/me/products", authMiddleware, (req, res) => {
  res.json({ products: req.user.store.products });
});

app.post("/api/me/products", authMiddleware, (req, res) => {
  const { name, price, stock, shipping, desc, image } = req.body;
  if (!name || !price) return res.status(400).json({ message: "Nom et prix requis" });

  const product = {
    id: uuid(),
    name: name.trim(),
    price: Number(price) || 0,
    stock: Number(stock) || 0,
    shipping: shipping || "Dakar 24h",
    desc: desc || "",
    image: image || "",
    createdAt: Date.now(),
  };

  const data = req.data;
  req.user.store.products.unshift(product);
  saveData(data);
  res.json({ product });
});

app.put("/api/me/products/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const product = req.user.store.products.find((p) => p.id === id);
  if (!product) return res.status(404).json({ message: "Produit non trouvé" });

  const { name, price, stock, shipping, desc, image } = req.body;
  if (name) product.name = name.trim();
  if (price != null) product.price = Number(price);
  if (stock != null) product.stock = Number(stock);
  if (shipping != null) product.shipping = shipping;
  if (desc != null) product.desc = desc;
  if (image != null) product.image = image;

  saveData(req.data);
  res.json({ product });
});

app.delete("/api/me/products/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const before = req.user.store.products.length;
  req.user.store.products = req.user.store.products.filter((p) => p.id !== id);
  if (req.user.store.products.length === before) return res.status(404).json({ message: "Produit non trouvé" });
  saveData(req.data);
  res.json({ ok: true });
});

app.post("/api/me/orders", authMiddleware, (req, res) => {
  const { productId, quantity, paymentMethod, customer } = req.body;
  const product = req.user.store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ message: "Produit introuvable" });
  const qty = Number(quantity) || 1;
  if (product.stock < qty) return res.status(400).json({ message: "Stock insuffisant" });

  if (!customer || !customer.firstName || !customer.lastName || !customer.address || !customer.phone) {
    return res.status(400).json({ message: "Informations client requises" });
  }

  product.stock -= qty;
  const total = product.price * qty;

  const order = {
    id: uuid(),
    productId,
    quantity: qty,
    total,
    paymentMethod: paymentMethod || "cod",
    customer: {
      firstName: customer.firstName.trim(),
      lastName: customer.lastName.trim(),
      address: customer.address.trim(),
      phone: customer.phone.trim(),
    },
    status: paymentMethod === "cod" ? "pending" : "paid",
    createdAt: Date.now(),
  };

  req.user.store.orders.push(order);
  req.user.store.sales += total;
  req.user.store.customers.push({ id: uuid(), date: Date.now(), amount: total });

  saveData(req.data);
  res.json({ order });
});

app.get("/api/me/orders", authMiddleware, (req, res) => {
  res.json({ orders: req.user.store.orders });
});

app.get("/api/me/orders/:orderId/invoice", authMiddleware, (req, res) => {
  const { orderId } = req.params;
  const order = req.user.store.orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ message: "Commande introuvable" });

  const product = req.user.store.products.find((p) => p.id === order.productId);
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=Facture-${order.id}.pdf`);

  doc.fontSize(20).text("Facture SunuMarket", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Boutique: ${req.user.store.name}`);
  doc.text(`Vendeur: ${req.user.name}`);
  doc.text(`Date: ${new Date(order.createdAt).toLocaleDateString("fr-FR")}`);
  doc.text(`Commande: ${order.id}`);
  doc.text(`Statut: ${order.status}`);
  doc.moveDown();

  doc.text("Informations client", { underline: true });
  doc.text(`${order.customer.firstName} ${order.customer.lastName}`);
  doc.text(order.customer.address);
  doc.text(order.customer.phone);
  doc.moveDown();

  doc.text("Détails du produit", { underline: true });
  if (product) {
    doc.text(`Produit: ${product.name}`);
    doc.text(`Prix unitaire: ${product.price} FCFA`);
  } else {
    doc.text("Produit supprimé du catalogue");
  }
  doc.text(`Quantité: ${order.quantity}`);
  doc.text(`Total: ${order.total} FCFA`);
  doc.text(`Paiement: ${order.paymentMethod}`);
  doc.moveDown();

  doc.text("Merci pour votre confiance.");
  doc.end();
});

app.put("/api/me/orders/:orderId/status", authMiddleware, (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;
  const allowed = ["pending", "paid", "shipped", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ message: "Statut de commande invalide" });

  const order = req.user.store.orders.find((o) => o.id === orderId);
  if (!order) return res.status(404).json({ message: "Commande introuvable" });

  order.status = status;
  req.user.notifications.unshift({
    id: uuid(),
    type: "status",
    orderId: order.id,
    message: `Statut de commande mis à jour : ${order.id} est maintenant ${status}`,
    date: Date.now(),
    status,
  });
  if (req.user.notifications.length > 25) req.user.notifications = req.user.notifications.slice(0, 25);

  saveData(req.data);
  res.json({ order });
});

app.get("/api/me/notifications", authMiddleware, (req, res) => {
  res.json({ notifications: req.user.notifications || [] });
});

app.post("/api/payments", async (req, res) => {
  const { method, amount, cardDetails, mobile, purpose, metadata = {} } = req.body;
  if (!method || !amount) return res.status(400).json({ message: "Méthode et montant requis" });
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ message: "Montant invalide" });

  const valid = ["wave", "orange_money", "card", "stripe", "paydunya", "flutterwave", "cod"];
  if (!valid.includes(method)) return res.status(400).json({ message: "Méthode inconnue" });

  if (["card", "stripe"].includes(method)) {
    if (!cardDetails || !/^\d{12,19}$/.test(cardDetails.number) || !/^\d{2}\/\d{2}$/.test(cardDetails.expiry) || !/^\d{3,4}$/.test(cardDetails.cvc)) {
      return res.status(400).json({ message: "Détails de carte invalides" });
    }
  }

  if (["wave", "orange_money", "paydunya", "flutterwave"].includes(method) && !mobile) {
    return res.status(400).json({ message: "Numéro mobile requis pour Wave, Orange Money, PayDunya ou Flutterwave" });
  }

  try {
    const data = loadData();

    if (method === "stripe") {
      if (stripe) {
        const [expMonth, expYear] = cardDetails.expiry.split("/").map((part) => Number(part));
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount),
          currency: "xof",
          payment_method_data: {
            type: "card",
            card: {
              number: cardDetails.number,
              exp_month: expMonth,
              exp_year: 2000 + expYear,
              cvc: cardDetails.cvc,
            },
          },
          confirm: true,
        });
        return res.json({ success: true, method, transactionId: paymentIntent.id, amount, provider: "stripe" });
      }
      return res.json({ success: true, method, transactionId: `stripe_sim_${Date.now()}`, amount, provider: "stripe" });
    }

    if (method === "paydunya") {
      if (process.env.PAYDUNYA_PRIVATE_KEY) {
        return res.json({ success: true, method, transactionId: `paydunya_${Date.now()}`, amount, provider: "paydunya" });
      }
      return res.json({ success: true, method, transactionId: `paydunya_sim_${Date.now()}`, amount, provider: "paydunya" });
    }

    if (method === "flutterwave") {
      if (process.env.FLUTTERWAVE_SECRET_KEY) {
        return res.json({ success: true, method, transactionId: `flutterwave_${Date.now()}`, amount, provider: "flutterwave" });
      }
      return res.json({ success: true, method, transactionId: `flutterwave_sim_${Date.now()}`, amount, provider: "flutterwave" });
    }

    if (method === "card") {
      return res.json({ success: true, method, transactionId: `card_${Date.now()}`, amount, provider: "card" });
    }

    if (method === "wave") {
      const transactionId = `wave_${Date.now()}`;
      const payment = {
        id: uuid(),
        transactionId,
        providerTransactionId: null,
        method: "wave",
        provider: "wave",
        purpose: purpose || "order",
        amount: Math.round(Number(amount)),
        currency: "XOF",
        mobile: mobile || null,
        metadata,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      data.payments.push(payment);
      saveData(data);

      return res.json({
        success: true,
        method,
        transactionId,
        amount: payment.amount,
        provider: "wave",
        paymentUrl: WAVE_PAYMENT_URL,
        status: payment.status,
      });
    }

    if (method === "orange_money") {
      return res.json({ success: true, method, transactionId: `${method}_${Date.now()}`, amount, provider: method });
    }

    return res.json({ success: true, method, amount, transactionId: `tx_${Date.now()}` });
  } catch (err) {
    console.error("Payment error", err);
    return res.status(500).json({ message: "Erreur de paiement", error: err.message || "unknown" });
  }
});

app.get("/api/payments/:transactionId/status", (req, res) => {
  const { transactionId } = req.params;
  const data = loadData();
  const payment = data.payments.find((p) => p.transactionId === transactionId);
  if (!payment) {
    return res.status(404).json({ message: "Paiement introuvable" });
  }

  return res.json({
    transactionId: payment.transactionId,
    providerTransactionId: payment.providerTransactionId,
    status: payment.status,
    amount: payment.amount,
    method: payment.method,
    updatedAt: payment.updatedAt,
  });
});

app.post("/api/payments/wave/webhook", (req, res) => {
  if (!verifyWaveWebhookSignature(req)) {
    return res.status(401).json({ message: "Signature webhook invalide" });
  }

  const payload = req.body || {};
  const data = loadData();

  const eventId = payload.event_id || payload.id || payload.event?.id || null;
  if (eventId && data.processedWebhookEvents.includes(eventId)) {
    return res.json({ received: true, duplicate: true });
  }

  const eventType = payload.event || payload.event_type || payload.type || payload.name || payload.data?.event || "";
  const providerTransactionId = payload.transaction_id
    || payload.payment_id
    || payload.data?.transaction_id
    || payload.data?.id
    || null;
  const localTransactionId = payload.metadata?.transactionId
    || payload.data?.metadata?.transactionId
    || payload.reference
    || payload.data?.reference
    || null;
  const status = normalizePaymentStatus(payload.status || payload.data?.status || payload.payment_status, eventType);

  let payment = null;
  if (localTransactionId) {
    payment = data.payments.find((p) => p.transactionId === localTransactionId) || null;
  }
  if (!payment && providerTransactionId) {
    payment = data.payments.find((p) => p.providerTransactionId === providerTransactionId) || null;
  }

  if (!payment) {
    payment = {
      id: uuid(),
      transactionId: localTransactionId || `wave_webhook_${Date.now()}`,
      providerTransactionId: providerTransactionId || null,
      method: "wave",
      provider: "wave",
      purpose: payload.metadata?.purpose || payload.data?.metadata?.purpose || "unknown",
      amount: Number(payload.amount || payload.data?.amount || 0),
      currency: payload.currency || payload.data?.currency || "XOF",
      mobile: payload.phone || payload.data?.phone || null,
      metadata: payload.metadata || payload.data?.metadata || {},
      status: status === "unknown" ? "pending" : status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.payments.push(payment);
  }

  if (providerTransactionId) payment.providerTransactionId = providerTransactionId;
  if (status !== "unknown") payment.status = status;
  payment.lastWebhookAt = Date.now();
  payment.updatedAt = Date.now();
  payment.lastWebhookPayload = payload;

  if (eventId) {
    data.processedWebhookEvents.push(eventId);
    if (data.processedWebhookEvents.length > 1000) {
      data.processedWebhookEvents = data.processedWebhookEvents.slice(-1000);
    }
  }

  saveData(data);
  return res.json({ received: true, status: payment.status, transactionId: payment.transactionId });
});

app.post("/api/store/:slug/order", async (req, res) => {
  const { slug } = req.params;
  const { productId, quantity, paymentMethod, customer, paymentDetails } = req.body;
  if (!productId || !quantity || !paymentMethod || !customer || !customer.firstName || !customer.lastName || !customer.address || !customer.phone) {
    return res.status(400).json({ message: "Informations de commande manquantes" });
  }

  const validMethods = ["wave", "orange_money", "card", "cod"];
  if (!validMethods.includes(paymentMethod)) {
    return res.status(400).json({ message: "Méthode de paiement invalide" });
  }

  const data = loadData();
  const seller = data.users.find((u) => u.store && u.store.slug === slug);
  if (!seller) return res.status(404).json({ message: "Boutique introuvable" });

  const product = seller.store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ message: "Produit introuvable" });

  const qty = Number(quantity) || 1;
  if (qty <= 0 || product.stock < qty) {
    return res.status(400).json({ message: "Quantité invalide ou stock insuffisant" });
  }

  if (paymentMethod === "card") {
    const card = paymentDetails?.cardDetails;
    if (!card || !/^\d{12,19}$/.test(card.number) || !/^\d{2}\/\d{2}$/.test(card.expiry) || !/^\d{3,4}$/.test(card.cvc)) {
      return res.status(400).json({ message: "Détails de carte invalides" });
    }
  }

  if ((paymentMethod === "wave" || paymentMethod === "orange_money") && !paymentDetails?.mobile) {
    return res.status(400).json({ message: "Numéro mobile requis pour Wave ou Orange Money" });
  }

  product.stock -= qty;
  const total = product.price * qty;
  const order = {
    id: uuid(),
    productId,
    quantity: qty,
    total,
    paymentMethod,
    paymentInfo: {
      method: paymentMethod,
      transactionId: `tx_${Date.now()}`,
      details: paymentDetails,
    },
    customer: {
      firstName: customer.firstName.trim(),
      lastName: customer.lastName.trim(),
      address: customer.address.trim(),
      phone: customer.phone.trim(),
    },
    status: paymentMethod === "cod" ? "pending" : "paid",
    createdAt: Date.now(),
  };

  const commission = Math.round(total * 0.05);
  order.commission = commission;
  order.sellerRevenue = total - commission;

  seller.store.orders.push(order);
  seller.store.sales += total - commission;
  seller.store.customers.push({ id: uuid(), date: Date.now(), amount: total - commission });
  seller.notifications = seller.notifications || [];
  seller.notifications.unshift({
    id: uuid(),
    type: "order",
    via: getSellerWhatsAppNumber(seller) ? "whatsapp" : "internal",
    orderId: order.id,
    message: `Nouvelle commande ${order.status === "paid" ? "payée" : "en attente"} : ${order.quantity} × ${product.name} (${order.paymentMethod})`,
    date: Date.now(),
    status: order.status,
  });
  if (seller.notifications.length > 25) seller.notifications = seller.notifications.slice(0, 25);

  await sendWhatsAppNotification(seller, order, product);

  saveData(data);
  res.json({ success: true, order });
});

app.post("/api/ai/suggest", authMiddleware, (req, res) => {
  const { productName, price, description } = req.body;

  const base = productName || "Votre produit";
  const suggestedPrice = price ? Number(price) * 1.08 : 1000;
  const hashs = [
    `#${base.replace(/\s+/g, "").toLowerCase()}`,
    "#vente",
    "#sunuMarket",
    "#bonneaffaire",
  ];

  const marketing = `Mettez en avant ${base} sur WhatsApp et Facebook. Utilisez le hashtag ${hashs[0]} pour gagner en visibilité.`;

  res.json({
    suggestedPrice: Math.round(suggestedPrice),
    recommendedDescription: description
      ? `Super produit : ${description}`
      : `Découvrez ${base} à prix imbattable !`,
    hashtags: hashs,
    advice: marketing,
  });
});

app.get("/api/stores", (req, res) => {
  const data = loadData();
  const stores = data.users
    .filter((u) => u.accountType === "seller" && u.store)
    .map((u) => {
      const products = u.store.products || [];
      const sortedProducts = products
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return {
        name: u.store.name,
        description: u.store.description,
        slug: u.store.slug,
        ownerName: u.name,
        socialLinks: u.socialLinks,
        sales: u.store.sales || 0,
        productCount: products.length,
        topProducts: sortedProducts.slice(0, 3).map((product) => product.name),
        createdAt: u.store.createdAt || 0,
        themeColor: u.store.themeColor || "#28a745",
      };
    });
  res.json(stores);
});

app.get("/api/store/:slug", (req, res) => {
  const { slug } = req.params;
  const data = loadData();
  const user = data.users.find((u) => u.store && u.store.slug === slug);
  if (!user) return res.status(404).json({ message: "Boutique introuvable" });
  res.json({ store: user.store, owner: { name: user.name, phone: user.phone, socialLinks: user.socialLinks } });
});

app.listen(PORT, () => {
  console.log(`SunuMarket API running on http://localhost:${PORT}`);
});

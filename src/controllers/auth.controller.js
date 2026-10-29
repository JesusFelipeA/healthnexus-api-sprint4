const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Correo y contraseña son obligatorios" });
    }

    const [rows] = await pool.query(
      "SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = ? LIMIT 1",
      [email],
    );
    const user = rows[0];

    if (
      !user ||
      !user.activo ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({ message: "Credenciales incorrectas" });
    }

    const token = jwt.sign(
      { id: user.id, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" },
    );

    res.json({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nombre, email, rol FROM usuarios WHERE id = ? AND activo = 1",
      [req.user.id],
    );
    if (!rows[0])
      return res.status(404).json({ message: "Usuario no encontrado" });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
};

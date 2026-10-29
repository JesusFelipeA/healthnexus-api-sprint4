const router = require("express").Router();
const ctrl = require("../controllers/auth.controller");
const auth = require("../middlewares/auth");

router.post("/login", ctrl.login);
router.get("/me", auth, ctrl.me);

module.exports = router;

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/smsController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

// POST /incoming je odstraněné — viz komentář v controllers/smsController.js.
router.post('/send', (req, res) => ctrl.sendSms(req, res));

module.exports = router;

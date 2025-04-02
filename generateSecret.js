const crypto = require('crypto');

// Generate a random string of 64 characters
const jwtSecret = crypto.randomBytes(32).toString('hex');
console.log('JWT_SECRET:', jwtSecret);
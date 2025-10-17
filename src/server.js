const fs = require('fs');
const path = require('path');
const https = require('https');

function createServer(app) {
  const options = {
    key: fs.readFileSync(path.join(__dirname, '../cert/key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '../cert/cert.pem'))
  };
  
  return https.createServer(options, app);
}

module.exports = createServer;

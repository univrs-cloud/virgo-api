How to build DEB
---
`npm install -g node-deb`

`npm install`

`node-deb --no-default-package-dependencies --no-rebuild --install-strategy copy -- server.js config.js routes/ services/`


How to install DEB
---
`dpkg -i virgo-api_1.0.0_all.deb`


How to start service
---
`systemctl enable --now virgo-api`


How to access server
---
`https://ip:3000`

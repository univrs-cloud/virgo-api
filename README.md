[![Build and release](https://github.com/univrs-cloud/virgo-api/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/univrs-cloud/virgo-api/actions/workflows/build-and-release.yml)

How to build DEB
---
`npm install`

`npm run deb`


How to install DEB
---
`apt install -y --reinstall ./virgo-api_1.0.0_all.deb`


How to start service/server
---
`systemctl enable --now virgo-api`


How to access server
---
`https://ip:3000`

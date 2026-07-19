# Changelog

## [0.4.0](https://github.com/kontourai/forage/compare/v0.3.0...v0.4.0) (2026-07-19)


### Features

* resolve exact snapshots from durable references ([#16](https://github.com/kontourai/forage/issues/16)) ([3b9fb3b](https://github.com/kontourai/forage/commit/3b9fb3b26ee3ac7028b2a9a9b9525a73cdeb2823)), closes [#15](https://github.com/kontourai/forage/issues/15)


### Fixes

* bound and canonicalize filesystem history, enforce source isolation, and reject writes beyond the configured retention ceiling before the initial 0.4.0 publication

## [0.3.0](https://github.com/kontourai/forage/compare/v0.2.0...v0.3.0) (2026-07-17)


### Features

* expose fetchSource via ./fetch subpath and add transient notModified 304 marker ([#13](https://github.com/kontourai/forage/issues/13)) ([d900e1c](https://github.com/kontourai/forage/commit/d900e1cf6b71b7e7f4b6d8df4f816b02346bb2b6))

## [0.2.0](https://github.com/kontourai/forage/compare/v0.1.0...v0.2.0) (2026-07-14)


### Features

* export guarded single-URL fetch surface via ./egress subpath ([#11](https://github.com/kontourai/forage/issues/11)) ([47cc8df](https://github.com/kontourai/forage/commit/47cc8df4597380a8c3b5df5595c5b7318d41b175))

## 0.1.0 (2026-07-14)


### Features

* MVP crawler — frontier + SSRF-pinned egress + replay (forage[#1](https://github.com/kontourai/forage/issues/1)) ([45e104a](https://github.com/kontourai/forage/commit/45e104ad00802b20a13fa949fba2462cb11f0702))
* sitemap-first discovery (forage[#2](https://github.com/kontourai/forage/issues/2)) ([7304e1b](https://github.com/kontourai/forage/commit/7304e1b38fd6613ba9475d57ac43c1decdb3e3b0))
* adaptive render via DNS-pinned browser transport (forage[#3](https://github.com/kontourai/forage/issues/3)) ([f1e0bae](https://github.com/kontourai/forage/commit/f1e0bae48a6e65d29651c504c2d49a5eb4be4b83))


### Maintenance

* release initial forage as 0.1.0 ([60b742a](https://github.com/kontourai/forage/commit/60b742aa68bbb7c3965da754bf963b9597990614))

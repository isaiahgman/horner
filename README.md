# Horner

A local-first reading companion for Professor Grant Horner's Ten Lists Bible
Reading System. Progress belongs to ten independent, looping chapter lists;
calendar time never creates a backlog.

The phone-first PWA stores progress locally in IndexedDB, works offline after
its first visit, and starts at Day 24 of the supplied resumed calendar.

## Development

```sh
npm install
npm run check
npm run dev
```

Production builds are deployable to GitHub Pages with the included workflow.
The hosted files contain no personal reading data; progress and history remain
inside the browser unless explicitly exported as a JSON backup.

See [the product specification](docs/product-spec.md) for the MVP behavior and
acceptance criteria.

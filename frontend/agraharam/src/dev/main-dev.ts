/**
 * index.html entry, served only by `npm run dev` and never bundled: registers the elements from source (the only
 * dev file allowed to import element source, §10.3) and mounts the fake HA shell, which creates the card.
 */
import '../agraharam.ts';
import './ha-shell.ts';

document.body.append(document.createElement('dev-ha-shell'));

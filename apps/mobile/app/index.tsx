/**
 * `/` — legacy entry URL. The Super App home (role selection + service hub)
 * lives at `/home`, which is the canonical destination after logout.
 * Both URLs render the same screen so refresh/deep-links keep working.
 */
export { default } from './home';

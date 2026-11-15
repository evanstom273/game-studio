/** Writes the PWA icons from the same generator as the default project icon. */
import { writeFileSync } from 'node:fs';
import { generateIconPng } from '../packages/project/src/png';
for (const size of [192, 512]) writeFileSync(`apps/editor/public/icon-${size}.png`, generateIconPng(size));
console.log('icons written');

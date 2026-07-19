import { config } from 'dotenv';
import { resolveGoogleModelId } from '../dist/googleModelResolver.js';

config();

const resolvedPro = await resolveGoogleModelId('gemini-1.5-pro');
const resolvedFlash = await resolveGoogleModelId('gemini-1.5-flash');

console.log(JSON.stringify({ resolvedPro, resolvedFlash }, null, 2));

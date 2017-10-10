// Imports
import requireDir from 'require-dir';
import { config } from 'dotenv';

/**
 * Gulpfile entry point
 */
config();
requireDir('./build');
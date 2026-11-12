import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../src/core/analysis';
import { VersionBundle } from '../src/core/model';
import { ProfileIndex } from '../src/core/profileIndex';

const ROOT = path.resolve(__dirname, '..', '..');
export const indexes = ['cgmes-2.4.15', 'ncp-2.2', 'ncp-2.5'].map(
  id => new ProfileIndex(JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', id + '.json'), 'utf8')) as VersionBundle),
);
export const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
export const run = (text: string, profiles?: string[]) => analyze(text, { indexes, profiles });

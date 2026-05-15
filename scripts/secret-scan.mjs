import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();

const patterns = [
  { name: 'OpenAI API key', re: /\bsk-(?:proj|live|test)?-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'JWT-like token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'inline env secret assignment', re: /\b(?:JDE_TOKEN|COGNOS_TOKEN|OPENAI_API_KEY|VITE_[A-Z0-9_]*(?:TOKEN|PASSWORD|API_KEY))=(?!<|\s*$)[^\s#]+/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
];

const findings = [];

function trackedFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean);
}

function scan() {
  for (const rel of trackedFiles()) {
    const path = join(root, rel);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.re.test(line)) {
          findings.push(`${rel}:${index + 1} ${pattern.name}`);
        }
      }
    });
  }
}

scan();

if (findings.length > 0) {
  console.error('Potential secrets found:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('No potential secrets found in tracked source tree scan.');

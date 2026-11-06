import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWrites } from '../src/adapters/shell-writes.ts';

const MARK = { write: '', delete: '-', from: '<', to: '>' };
const files = (cmd: string, powershell = false) =>
  shellWrites(cmd, { powershell }).map((w) => `${MARK[w.op]}${w.dir ? w.dir + ' : ' : ''}${w.path}${w.guessed ? ' ?' : ''}`);

test('redirects write files; /dev/null and descriptor copies do not', () => {
  assert.deepEqual(files('echo hi > out.txt'), ['out.txt']);
  assert.deepEqual(files('npm test >> results/test.txt 2>&1'), ['results/test.txt']);
  assert.deepEqual(files('grep -rn foo src 2>/dev/null | head'), []);
  assert.deepEqual(files('ls >/dev/null 2>&1; echo done'), []);
  assert.deepEqual(files('cmd &> all.txt'), ['all.txt']);
  assert.deepEqual(files('sort < in.txt'), []);
});

test('logs are not edits: .log files and background commands', () => {
  assert.deepEqual(files('npm test > test.log 2>&1'), []);
  assert.deepEqual(files('npm test 2>&1 | tee -a out.log'), []);
  assert.deepEqual(files('node server.js > server.out 2>&1 &'), []);
  assert.deepEqual(files('node server.js > s.out 2>&1 & sleep 1; echo hi > note.txt'), ['note.txt']);
  assert.deepEqual(files('npm test *> test.log', true), []);
});

test('text inside quotes, comments and heredoc bodies is not a command', () => {
  assert.deepEqual(files(`grep -n "sed -i\\|> x" file.ts`), []);
  assert.deepEqual(files(`git commit -m "use a > b, rm old.txt"`), []);
  assert.deepEqual(files('echo ok # > not-a-file.txt'), []);
  assert.deepEqual(files(`cat <<'EOF'\nrm -rf everything.txt > x.txt\nEOF\necho next`), []);
});

test('heredoc into a file', () => {
  assert.deepEqual(files(`cat > notes/plan.md <<'EOF'\n# Plan\n> quoted line\nEOF`), ['notes/plan.md']);
  assert.deepEqual(files(`cat <<EOF > a.txt\nhello\nEOF\ncat <<-END >> b.txt\n\tx\n\tEND`), ['a.txt', 'b.txt']);
});

test('file commands', () => {
  assert.deepEqual(files('tee -a out.txt < x'), ['out.txt']);
  assert.deepEqual(files('touch a.ts b.ts'), ['a.ts', 'b.ts']);
  assert.deepEqual(files('rm -f old.js'), ['-old.js']);
  assert.deepEqual(files('cp -r src/a.ts dist/a.ts'), ['dist/a.ts']);
  assert.deepEqual(files('mv draft.md final.md'), ['<draft.md', '>final.md']);
  assert.deepEqual(files("sed -i 's/a/b/g' src/x.ts src/y.ts"), ['src/x.ts', 'src/y.ts']);
  assert.deepEqual(files("sed -i.bak -e 's/a/b/' -e 's/c/d/' x.ts"), ['x.ts']);
  assert.deepEqual(files("sed -n '1,5p' x.ts"), []);
  assert.deepEqual(files("perl -pi -e 's/a/b/' x.pl"), ['x.pl']);
  assert.deepEqual(files('sudo FOO=1 tee /etc/hosts'), ['/etc/hosts']);
});

test('cd before a write is remembered', () => {
  assert.deepEqual(files("cd /c/Project/app && sed -i 's/a/b/' web/app.js"), ['/c/Project/app : web/app.js']);
  assert.deepEqual(files('echo x > a.txt; cd sub; echo y > b.txt'), ['a.txt', 'sub : b.txt']);
});

test('variables set in the same command line are expanded', () => {
  assert.deepEqual(files('SP=/tmp/work; echo x > $SP/out.txt'), ['/tmp/work/out.txt']);
  assert.deepEqual(files('export D=/tmp/d && sed -i s/a/b/ "${D}/x.ts"'), ['/tmp/d/x.ts']);
  assert.deepEqual(files(`$D = 'C:/w'; Set-Content "$D/a.txt" 1`, true), ['C:/w/a.txt']);
  assert.deepEqual(files('echo x > $UNKNOWN/out.txt'), []);
});

test('scripts: write targets, and path-like strings only as guesses', () => {
  const user = `node - <<'EOF'
const fs=require('fs');
const edit=(f,pairs)=>{let s=fs.readFileSync(f,'utf8');const nl=s.includes('\\r\\n')?'\\r\\n':'\\n';fs.writeFileSync(f,s)};
edit('web/app.js',[[\`a > b\`,\`c\`]]);
edit('README.md',[[\`x\`,\`y\`]]);
EOF
grep -n "startup" web/app.js; node --check web/app.js && echo ok`;
  assert.deepEqual(files(user), ['web/app.js ?', 'README.md ?']);
  assert.deepEqual(files(`node -e "require('fs').writeFileSync('out.json', '{}')"`), ['out.json']);
  assert.deepEqual(files(`node -e "console.log(require('fs').readFileSync('package.json','utf8'))"`), []);
  assert.deepEqual(files(`python3 - <<'EOF'\nfrom pathlib import Path\nPath('docs/a.md').write_text('x')\nprint(open('cfg.toml').read())\nEOF`), ['docs/a.md']);
  assert.deepEqual(files(`python -c "open('out.csv', 'w').write('a')"`), ['out.csv']);
  assert.deepEqual(files(`python -c "print(open('in.csv').read())"`), []);
  assert.deepEqual(files('node scripts/build.mjs'), []);
  // A path mentioned in the text a script writes is not one of its targets.
  const docs = `node -e "const fs=require('fs'); fs.writeFileSync(f, s.replace('x', 'the parser in \`src/shell.ts\` reads it'))"`;
  assert.deepEqual(files(docs), []);
  assert.deepEqual(files(`node -e "for (const f of ['a.ts', 'b.ts']) fs.writeFileSync(f, '')"`), ['a.ts ?', 'b.ts ?']);
});

test('bash -c and powershell -Command are looked into', () => {
  assert.deepEqual(files(`bash -c "echo x > a.txt"`), ['a.txt']);
  assert.deepEqual(files(`powershell -Command "Set-Content -Path b.txt -Value 1"`), ['b.txt']);
});

test('PowerShell cmdlets and redirects', () => {
  assert.deepEqual(files('Set-Content -Path .\\a.txt -Value "x > y"', true), ['.\\a.txt']);
  assert.deepEqual(files("'x' | Out-File -FilePath out.txt -Encoding utf8", true), ['out.txt']);
  assert.deepEqual(files('Add-Content notes.md "line"', true), ['notes.md']);
  assert.deepEqual(files('Remove-Item -Recurse -Force dist\\old.js', true), ['-dist\\old.js']);
  assert.deepEqual(files('Copy-Item a.txt -Destination b.txt', true), ['b.txt']);
  assert.deepEqual(files('Rename-Item src\\a.ts b.ts', true), ['<src\\a.ts', '>src\\b.ts']);
  assert.deepEqual(files('New-Item -ItemType Directory -Force out', true), []);
  assert.deepEqual(files('Get-Content x.txt | Select-Object -First 5', true), []);
  assert.deepEqual(files('npm test *> results.txt', true), ['results.txt']);
  assert.deepEqual(files("git log -1 2>$null; Write-Output 'a > b'", true), []);
  assert.deepEqual(files("@'\nSet-Content x.txt\n'@ | Out-File y.txt", true), ['y.txt']);
});

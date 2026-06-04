/**
 *  ClusterODX - tests for the convict-based config loader.
 *
 *  Each scenario spawns a fresh `node` subprocess so the test gets a
 *  pristine `process.argv` and a fresh `require` cache. The subprocess
 *  prints the resolved config as JSON; the test parses and asserts.
 *
 *  Run with: npm test (uses Node's built-in test runner).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * Spawn a fresh node, require the config, print as JSON to stdout.
 * Returns { config, stdout, stderr, status }. `config` is `null` if the
 * process exited non-zero (validation error, missing file, etc.).
 */
function loadConfig(extraArgv = []) {
    const result = spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(require("./config")))', '--', ...extraArgv],
        { cwd: repoRoot, encoding: 'utf8' }
    );
    let config = null;
    if (result.status === 0 && result.stdout) {
        try { config = JSON.parse(result.stdout); }
        catch (_) { /* leave as null */ }
    }
    return { config, stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// ─── Defaults from config-default.json ────────────────────────────────────

test('defaults: public_address is empty (canonical bug-prevention assertion)', () => {
    const { config, status } = loadConfig();
    assert.equal(status, 0, 'load should succeed with no args');
    assert.equal(config.public_address, '');
});

test('defaults: cloud_provider, splitmerge, ports, debug match config-default.json', () => {
    const { config } = loadConfig();
    assert.equal(config.cloud_provider, 'local');
    assert.equal(config.splitmerge, true);
    assert.equal(config.port, 3000);
    assert.equal(config.admin_cli_port, 8080);
    assert.equal(config.admin_web_port, 10000);
    assert.equal(config.debug, false);
    assert.equal(config.log_level, 'info');
    assert.equal(config.token, '');
});

test('defaults: use_ssl derives from ssl_key + ssl_cert (false when both empty)', () => {
    const { config } = loadConfig();
    assert.equal(config.use_ssl, false);
});

test('defaults: nested logger object is populated with constants + level from log_level', () => {
    const { config } = loadConfig();
    assert.equal(config.logger.level, 'info');
    assert.equal(config.logger.maxFileSize, 1024 * 1024 * 100);
    assert.equal(config.logger.maxFiles, 10);
    assert.equal(config.logger.logDirectory, '');
});

test('defaults: nested accessLog object is populated with constants + logFile from access_log', () => {
    const { config } = loadConfig();
    assert.equal(config.accessLog.logFile, '');
    assert.equal(config.accessLog.maxFileSize, 1024 * 1024 * 100);
});

// ─── User --config JSON (kebab-case, backward compatible) ─────────────────

test('user JSON: kebab-case public-address populates snake config.public_address', () => {
    // This is the canonical regression test for the silent-drop bug
    // that motivated this refactor. Before convict + strict mode, this
    // would have returned an empty string.
    const { config, status } = loadConfig(['--config', 'test/fixtures/user-kebab.json']);
    assert.equal(status, 0);
    assert.equal(config.public_address, 'http://clusterodx:3000');
});

test('user JSON: log-level kebab in user config drives BOTH log_level AND logger.level', () => {
    const { config } = loadConfig(['--config', 'test/fixtures/user-kebab.json']);
    assert.equal(config.log_level, 'debug');
    assert.equal(config.logger.level, 'debug');
});

test('user JSON: deprecated cluster-address still accepted under strict mode', () => {
    // The schema declares cluster_address as a deprecated/unused entry
    // specifically so legacy operator JSON files validate cleanly.
    const { config, status } = loadConfig(['--config', 'test/fixtures/user-kebab.json']);
    assert.equal(status, 0);
    assert.equal(config.cluster_address, 'legacy-still-accepted');
});

test('user JSON: scalar values override config-default.json values (port)', () => {
    const { config } = loadConfig(['--config', 'test/fixtures/user-kebab.json']);
    assert.equal(config.port, 4000, 'user JSON port should beat default 3000');
});

test('user JSON: ssl-key + ssl-cert + secure-port together flip use_ssl true', () => {
    const { config } = loadConfig(['--config', 'test/fixtures/user-with-ssl.json']);
    assert.equal(config.use_ssl, true);
    assert.equal(config.ssl_key, '/etc/ssl/key.pem');
    assert.equal(config.ssl_cert, '/etc/ssl/cert.pem');
    assert.equal(config.secure_port, 4443);
});

// ─── CLI overrides ────────────────────────────────────────────────────────

test('CLI: --public-address beats the value from --config JSON', () => {
    const { config } = loadConfig([
        '--config', 'test/fixtures/user-kebab.json',
        '--public-address', 'http://from-cli/',
    ]);
    assert.equal(config.public_address, 'http://from-cli/');
});

test('CLI: --log-level beats the value from --config JSON', () => {
    const { config } = loadConfig([
        '--config', 'test/fixtures/user-kebab.json',
        '--log-level', 'verbose',
    ]);
    assert.equal(config.log_level, 'verbose');
    assert.equal(config.logger.level, 'verbose');
});

test('CLI: --port beats the value from --config JSON', () => {
    const { config } = loadConfig([
        '--config', 'test/fixtures/user-kebab.json',
        '--port', '5000',
    ]);
    assert.equal(config.port, 5000);
});

// ─── Strict mode: unknown / invalid keys fail loudly ─────────────────────

test('strict: a typo in user JSON throws a clear error at load', () => {
    const { config, status, stderr } = loadConfig(['--config', 'test/fixtures/user-typo.json']);
    assert.equal(status, 1, 'process should exit non-zero on schema violation');
    assert.equal(config, null);
    assert.match(stderr, /not declared in the schema/);
    assert.match(stderr, /publik_address/);
});

test('strict: an enum violation (invalid log-level) throws a clear error', () => {
    const { config, status, stderr } = loadConfig(['--config', 'test/fixtures/user-invalid-enum.json']);
    assert.equal(status, 1);
    assert.equal(config, null);
    assert.match(stderr, /log_level/);
});

// ─── --help is generated from the schema ─────────────────────────────────

test('--help prints usage, every schema arg, and exits 0', () => {
    const result = spawnSync(process.execPath, ['config.js', '--help'], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node index\.js \[options\]/);
    assert.match(result.stdout, /--config <path>/);
    assert.match(result.stdout, /--public-address/);
    assert.match(result.stdout, /--cluster-address/);
    assert.match(result.stdout, /--cloud-provider/);
    assert.match(result.stdout, /Log Levels:/);
});

/**
 *  ClusterODX - A reverse proxy, load balancer and task tracker for NodeODX
 *  Copyright (C) 2018-present WebODM Contributors
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 *  ────────────────────────────────────────────────────────────────────
 *  Convict-based config loader.
 *
 *  Replaces the previous hand-rolled minimist + JSON merger. The schema
 *  below is the single source of truth: CLI flags, env vars, defaults,
 *  types, validation, and (most of) the help text are all derived from
 *  one declaration per option.
 *
 *  Strict mode is enabled, so an operator setting a key in their JSON
 *  config that does NOT appear in the schema fails loudly at startup —
 *  this closes the silent-drop class of bug that previously affected
 *  any key whose name was in argDefs.string but missing from
 *  config-default.json (the canonical example: public-address).
 *
 *  Backward compatibility:
 *    - JSON config files still use kebab-case keys (port, secure-port,
 *      public-address, …); this loader converts to snake_case for
 *      property access so existing operator files keep working.
 *    - The exported object preserves the previous public surface:
 *      `config.public_address`, `config.use_ssl`, `config.logger.level`,
 *      `config.accessLog.logFile`, etc. — no other module needs editing.
 *  ────────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('fs');
const convict = require('convict');
convict.addFormats(require('convict-format-with-validator'));

// ─── Helpers ─────────────────────────────────────────────────────────────

// Operator config files ship with kebab-case keys; convict's property
// names are snake_case. Convert at the boundary so the file format we've
// always supported keeps working without forcing operators to migrate.
function kebabToSnake(obj) {
    const out = {};
    for (const k in obj) out[k.replace(/-/g, '_')] = obj[k];
    return out;
}

// Tiny argv lookup so we can pre-handle --config and --help without
// invoking a separate CLI parser. Convict reads everything else from
// argv via the `arg` field in each schema entry.
function cliArg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

// ─── Schema (single source of truth) ─────────────────────────────────────

const schema = {
    port: {
        doc:     'Port to bind the server to.',
        format:  'port',
        default: 3000,
        arg:     'port',
        env:     'PORT',
    },
    secure_port: {
        doc:     'If SSL is enabled and you want to expose both a secure and non-secure service, set this. 0 = SSL-only.',
        format:  'int',
        default: 0,
        arg:     'secure-port',
    },
    admin_cli_port: {
        doc:     'Port to bind the admin CLI to. 0 disables.',
        format:  'int',
        default: 8080,
        arg:     'admin-cli-port',
    },
    admin_web_port: {
        doc:     'Port to bind the admin web interface to. 0 disables.',
        format:  'int',
        default: 10000,
        arg:     'admin-web-port',
    },
    admin_pass: {
        doc:       'Password to log in to the admin functions. Empty = no password.',
        format:    String,
        default:   '',
        arg:       'admin-pass',
        env:       'ADMIN_PASS',
        sensitive: true,
    },
    cloud_provider: {
        doc:     'Cloud provider for token validation and limits.',
        format:  ['local', 'lightning', 'lightning-dev'],
        default: 'local',
        arg:     'cloud-provider',
    },
    downloads_from_s3: {
        doc:     'Manually set the S3 URL prefix where to redirect /task/<uuid>/download requests. Empty = forward to nodes.',
        format:  String,
        default: '',
        arg:     'downloads-from-s3',
    },
    splitmerge: {
        doc:     'Set this server as the cluster node for all split/merge tasks. --no-splitmerge to disable.',
        format:  Boolean,
        default: true,
        arg:     'splitmerge',
    },
    cluster_address: {
        // NOTE: legacy. No live source file currently reads
        // `config.cluster_address`; `netutils.js:publicAddressPath()` reads
        // `config.public_address` instead. Kept here so operator JSON
        // files containing the historical `cluster-address` key continue
        // to validate under strict mode. Safe to delete once an upstream
        // rename audit confirms no consumer expects it.
        doc:     '(Deprecated, unused.) Was once the URL nodes used to reach this ClusterODX. Use public-address instead.',
        format:  String,
        default: '',
        arg:     'cluster-address',
    },
    public_address: {
        doc:     'Public URL nodes use to reach this ClusterODX (e.g. http://clusterodx:3000). Empty = derive from the inbound Host header (which is wrong for docker-network setups).',
        format:  String,
        default: '',
        arg:     'public-address',
        env:     'PUBLIC_ADDRESS',
    },
    token: {
        doc:       'Token that must be passed on every request. Empty = no auth (loopback-only deployments).',
        format:    String,
        default:   '',
        arg:       'token',
        env:       'CLUSTERODX_TOKEN',
        sensitive: true,
    },
    debug: {
        doc:     'Disable caches and other settings to facilitate debug.',
        format:  Boolean,
        default: false,
        arg:     'debug',
    },
    log_level: {
        doc:     'Log verbosity.',
        format:  ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
        default: 'info',
        arg:     'log-level',
    },
    upload_max_speed: {
        doc:     'Upload-to-node speed limit in bytes/sec. 0 = unlimited.',
        format:  'int',
        default: 0,
        arg:     'upload-max-speed',
    },
    flood_limit: {
        doc:     'Max simultaneous concurrent task uploads per user. 0 = unlimited.',
        format:  'int',
        default: 0,
        arg:     'flood-limit',
    },
    stale_uploads_timeout: {
        doc:     'Hours of inactivity before pruning temp uploads. 0 = do not remove (a 48h hard cap is enforced regardless).',
        format:  'int',
        default: 0,
        arg:     'stale-uploads-timeout',
    },
    ssl_key: {
        doc:     'Path to .pem SSL key file.',
        format:  String,
        default: '',
        arg:     'ssl-key',
    },
    ssl_cert: {
        doc:     'Path to .pem SSL certificate file.',
        format:  String,
        default: '',
        arg:     'ssl-cert',
    },
    asr: {
        doc:     'Path to autoscaler config. Empty = autoscaler disabled.',
        format:  String,
        default: '',
        arg:     'asr',
    },
    access_log: {
        doc:     'Path where to store the access log. Empty = no access log.',
        format:  String,
        default: '',
        arg:     'access-log',
    },
};

// ─── --help (preserves the original CLI behavior) ────────────────────────

if (process.argv.includes('--help')) {
    console.log(`Usage: node index.js [options]\n\nOptions:`);
    console.log(`    --config <path>\tPath to JSON configuration file. (default: config-default.json)`);
    for (const spec of Object.values(schema)) {
        if (!spec.arg) continue;
        console.log(`    --${spec.arg}\t${spec.doc}`);
    }
    console.log(`\nLog Levels: error | warn | info | verbose | debug | silly`);
    process.exit(0);
}

// ─── Load (defaults file, then user --config file, then env, then CLI) ───

const config = convict(schema);

try {
    const defaultsPath = 'config-default.json';
    if (fs.existsSync(defaultsPath)) {
        config.load(kebabToSnake(JSON.parse(fs.readFileSync(defaultsPath, 'utf8'))));
    }
} catch (e) {
    console.warn(`config-default.json: ${e.message}`);
    process.exit(1);
}

const userPath = cliArg('config');
if (userPath && userPath !== 'config-default.json') {
    try {
        config.load(kebabToSnake(JSON.parse(fs.readFileSync(userPath, 'utf8'))));
    } catch (e) {
        console.warn(`${userPath}: ${e.message}`);
        process.exit(1);
    }
}

// Strict mode: an operator config file containing a key that is not in
// the schema above (typo, deprecated rename, half-finished migration)
// throws here. This is the line that would have prevented the bug
// we just spent four hours chasing.
config.validate({ allowed: 'strict' });

// ─── Compose the final config (preserving the previous public surface) ───

const props = config.getProperties();

// Derived: SSL is "on" when both key and cert are configured.
props.use_ssl = !!(props.ssl_key && props.ssl_cert);

// Nested objects the original loader assembled by hand. Kept as-is so
// existing readers (libs/logger.js, libs/accessLog.js) need no changes.
props.logger = {
    level:        props.log_level,
    maxFileSize:  1024 * 1024 * 100,   // 100 MB
    maxFiles:     10,
    logDirectory: '',
};
props.accessLog = {
    maxFileSize: 1024 * 1024 * 100,    // 100 MB
    logFile:     props.access_log,
};

module.exports = props;

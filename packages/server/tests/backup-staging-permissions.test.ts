import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDatabaseForTests, getDatabase } from '../database/client';
import { createFullBackup, listBackups, validateBackup } from '../services/records.service';
import type { RequestUser } from '../domain/request-user';
const admin: RequestUser = { id: 'synthetic-backup-admin', displayName: 'Synthetic', provider: 'development', authenticated: true, isGatewayAdmin: true };
test('backup normalizes private copy modes before checksumming without changing the readable sources', t => {
    const storage = mkdtempSync(join(tmpdir(), 'backup-copy-modes-'));
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = storage;
    const copy = fs.cpSync;
    try {
        getDatabase().prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,'Synthetic',1)").run(admin.id);
        const sourceDir = join(storage, 'reports', 'nested');
        mkdirSync(sourceDir, { recursive: true });
        chmodSync(sourceDir, 0o750);
        const source = join(sourceDir, 'sample.txt');
        writeFileSync(source, 'Synthetic', { mode: 0o640 });
        const secret = join(storage, 'secrets', 'synthetic.bin');
        mkdirSync(join(storage, 'secrets'), { recursive: true });
        writeFileSync(secret, 'Synthetic', { mode: 0o640 });
        // Simulate a copy that lost the source ACL while retaining group-only modes.
        // Assertions also exercise owner modes when tests run as root in CI.
        t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
            copy(...args);
            if (String(args[0]) === join(storage, 'reports')) {
                const target = String(args[1]);
                chmodSync(join(target, 'nested', 'sample.txt'), 0o040);
                chmodSync(join(target, 'nested'), 0o050);
                chmodSync(target, 0o050);
            }
        });
        syncBuiltinESMExports();
        const backup = createFullBackup(admin);
        assert.ok(existsSync(backup.path));
        assert.ok(listBackups(admin).some(item => item.id === backup.id));
        const validation = validateBackup(admin, backup.id);
        assert.equal(validation.valid, true, JSON.stringify(validation.errors));
        const extracted = join(storage, 'inspection');
        mkdirSync(extracted);
        execFileSync('tar', ['-xzf', backup.path, '-C', extracted]);
        assert.equal(readFileSync(join(extracted, 'reports', 'nested', 'sample.txt'), 'utf8'), 'Synthetic');
        assert.equal(statSync(join(extracted, 'reports')).mode & 0o777, 0o700);
        assert.equal(statSync(join(extracted, 'reports', 'nested')).mode & 0o777, 0o700);
        assert.equal(statSync(join(extracted, 'reports', 'nested', 'sample.txt')).mode & 0o777, 0o600);
        assert.equal(statSync(join(extracted, 'secrets', 'synthetic.bin')).mode & 0o777, 0o600);
        assert.equal(statSync(sourceDir).mode & 0o777, 0o750);
        assert.equal(statSync(source).mode & 0o777, 0o640);
        assert.equal(statSync(secret).mode & 0o777, 0o640);
    }
    finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(storage, { recursive: true, force: true });
    }
});
test('backup copy permission handling does not follow symlinks', () => {
    const storage = mkdtempSync(join(tmpdir(), 'backup-copy-links-'));
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = storage;
    try {
        getDatabase().prepare("INSERT INTO users(id,display_name,is_gateway_admin) VALUES(?,'Synthetic',1)").run(admin.id);
        const outside = join(storage, 'outside.txt');
        writeFileSync(outside, 'Synthetic', { mode: 0o640 });
        const reports = join(storage, 'reports');
        mkdirSync(reports, { recursive: true });
        symlinkSync(outside, join(reports, 'link.txt'));
        const backup = createFullBackup(admin);
        assert.ok(existsSync(backup.path));
        assert.equal(statSync(outside).mode & 0o777, 0o640);
        assert.equal(readFileSync(outside, 'utf8'), 'Synthetic');
        assert.ok(lstatSync(join(reports, 'link.txt')).isSymbolicLink());
    }
    finally {
        closeDatabaseForTests();
        if (previous === undefined)
            delete process.env.STORAGE_DIR;
        else
            process.env.STORAGE_DIR = previous;
        rmSync(storage, { recursive: true, force: true });
    }
});

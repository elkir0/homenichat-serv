<?php
/**
 * FreePBX Check Extension Exists Script
 *
 * Usage: php freepbx-extension-exists.php <extension>
 *
 * Returns JSON:
 *   {"exists": true}
 *   {"exists": false}
 */

if ($argc < 2) {
    echo json_encode(["exists" => false, "error" => "Missing extension argument"]);
    exit(1);
}

$extension = $argv[1];

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["exists" => false]);
    exit(0);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();
    $user = $freepbx->Core->getUser($extension);
    echo json_encode(["exists" => ($user !== false && $user !== null)]);
} catch (Exception $e) {
    echo json_encode(["exists" => false]);
}

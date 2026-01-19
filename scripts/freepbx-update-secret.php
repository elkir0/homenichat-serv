<?php
/**
 * FreePBX Update Extension Secret Script
 * Updates the SIP password for an extension
 *
 * Usage: php freepbx-update-secret.php <extension> <newSecret>
 *
 * Example:
 *   php freepbx-update-secret.php 1000 NewPassword123
 *
 * Returns JSON:
 *   {"success": true}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 3) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-update-secret.php <extension> <newSecret>"
    ]);
    exit(1);
}

$extension = $argv[1];
$newSecret = $argv[2];

// Validate extension number
if (!preg_match('/^\d{3,6}$/', $extension)) {
    echo json_encode(["success" => false, "error" => "Invalid extension number"]);
    exit(1);
}

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    // Check if extension exists
    $device = $freepbx->Core->getDevice($extension);
    if (!$device) {
        echo json_encode(["success" => false, "error" => "Extension $extension not found"]);
        exit(0);
    }

    // Update secret
    $device['secret'] = $newSecret;
    $freepbx->Core->editDevice($extension, $device);

    // Mark configuration as needing reload
    needreload();

    echo json_encode(["success" => true, "extension" => $extension]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}

<?php
/**
 * FreePBX Delete Trunk Script
 * Deletes a trunk from FreePBX
 *
 * Usage: php freepbx-delete-trunk.php <trunkNameOrId>
 *
 * Example:
 *   php freepbx-delete-trunk.php GSM-MODEM-1
 *   php freepbx-delete-trunk.php 5
 *
 * Returns JSON:
 *   {"success": true}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 2) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-delete-trunk.php <trunkNameOrId>"
    ]);
    exit(1);
}

$trunkNameOrId = $argv[1];

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    // Find trunk ID
    $trunkId = null;
    $trunks = $freepbx->Core->getTrunks();

    foreach ($trunks as $trunk) {
        if ($trunk['name'] === $trunkNameOrId || $trunk['trunkid'] == $trunkNameOrId) {
            $trunkId = $trunk['trunkid'];
            break;
        }
    }

    if (!$trunkId) {
        echo json_encode(["success" => false, "error" => "Trunk '$trunkNameOrId' not found"]);
        exit(0);
    }

    // Delete trunk
    $freepbx->Core->deleteTrunk($trunkId);

    // Mark configuration as needing reload
    needreload();

    echo json_encode(["success" => true, "trunkId" => $trunkId]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}

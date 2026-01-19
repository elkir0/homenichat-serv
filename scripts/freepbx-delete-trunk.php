<?php
/**
 * FreePBX Delete Trunk Script
 * Deletes a trunk from FreePBX
 *
 * Note: getTrunks() crashes on FreePBX 17 due to BMO module loading issue
 * Solution: Use MySQL direct query to find trunk, then deleteTrunk() to delete
 *
 * Usage: php freepbx-delete-trunk.php <trunkNameOrId>
 *
 * Example:
 *   php freepbx-delete-trunk.php GSM-MODEM-1
 *   php freepbx-delete-trunk.php 5
 *
 * Returns JSON:
 *   {"success": true, "deleted": "GSM-MODEM-1"}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 2) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-delete-trunk.php <trunkNameOrId>"
    ]);
    exit(1);
}

$identifier = $argv[1];

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();
    $db = $freepbx->Database;

    // Find trunk by name or ID using MySQL direct query
    // Note: getTrunks() crashes on FreePBX 17
    if (is_numeric($identifier)) {
        $stmt = $db->prepare("SELECT trunkid, name FROM trunks WHERE trunkid = ?");
    } else {
        $stmt = $db->prepare("SELECT trunkid, name FROM trunks WHERE name = ?");
    }
    $stmt->execute([$identifier]);
    $trunk = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$trunk) {
        echo json_encode(["success" => false, "error" => "Trunk '$identifier' not found"]);
        exit(0);
    }

    // Delete trunk using Core method (this one works)
    $freepbx->Core->deleteTrunk($trunk['trunkid']);

    // Mark configuration as needing reload
    needreload();

    echo json_encode([
        "success" => true,
        "trunkId" => $trunk['trunkid'],
        "deleted" => $trunk['name']
    ]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}

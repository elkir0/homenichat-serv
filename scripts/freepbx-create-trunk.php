<?php
/**
 * FreePBX Create Trunk Script
 * Creates a custom trunk for chan_quectel GSM modem
 *
 * Usage: php freepbx-create-trunk.php <name> <modemId> <phoneNumber>
 *
 * Example:
 *   php freepbx-create-trunk.php GSM-MODEM-1 modem-1 +590690402352
 *
 * Returns JSON:
 *   {"success": true, "trunkId": 5}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 4) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-create-trunk.php <name> <modemId> <phoneNumber>"
    ]);
    exit(1);
}

$name = $argv[1];
$modemId = $argv[2];
$phoneNumber = $argv[3];

// Validate inputs
$name = preg_replace('/[^A-Z0-9_-]/i', '', $name);
$modemId = preg_replace('/[^a-z0-9_-]/i', '', $modemId);

if (empty($name) || empty($modemId)) {
    echo json_encode(["success" => false, "error" => "Invalid trunk name or modem ID"]);
    exit(1);
}

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed (/etc/freepbx.conf not found)"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    // Check if trunk already exists
    $trunks = $freepbx->Core->getTrunks();
    foreach ($trunks as $trunk) {
        if (strtolower($trunk['name']) === strtolower($name)) {
            echo json_encode(["success" => false, "error" => "Trunk '$name' already exists"]);
            exit(0);
        }
    }

    // Create trunk with correct 3-argument signature:
    // addTrunk($name, $tech, $settings)
    $tech = "custom";
    $settings = [
        "outcid" => $phoneNumber,
        "maxchans" => "1",
        "keepcid" => "on",
        "disabled" => "off",
        "channelid" => $modemId,
        "dialoutprefix" => "",
        // Custom dial string for chan_quectel
        // $OUTNUM$ is replaced by FreePBX with the dialed number
        "custom_dial" => "Quectel/{$modemId}/\$OUTNUM\$"
    ];

    $trunkId = $freepbx->Core->addTrunk($name, $tech, $settings);

    if ($trunkId) {
        // Mark configuration as needing reload
        needreload();

        echo json_encode([
            "success" => true,
            "trunkId" => $trunkId,
            "trunkName" => $name,
            "dialString" => "Quectel/{$modemId}/\$OUTNUM\$"
        ]);
    } else {
        echo json_encode(["success" => false, "error" => "Failed to create trunk"]);
    }

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}

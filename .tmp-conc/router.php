<?php
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($uri === '/slow') { usleep(4000000); echo 'slow-ok'; return true; }
if ($uri === '/fast') { echo 'fast-ok'; return true; }
echo 'root';

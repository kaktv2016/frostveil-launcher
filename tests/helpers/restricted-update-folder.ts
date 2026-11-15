import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const execute=promisify(execFile);

export async function restrictFixtureFeed(directory:string,tempRoot:string){
 const resolved=await fs.realpath(directory);
 assert.equal(path.dirname(resolved),await fs.realpath(tempRoot));
 const script=`
  $ErrorActionPreference = 'Stop'
  $folder = $env:FROSTVEIL_TEST_FEED_DIRECTORY
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')
  $acl = Get-Acl -LiteralPath $folder
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Unexpected fixture owner' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($value in $trusted) {
    $sid = [Security.Principal.SecurityIdentifier]::new($value)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
  }
  Set-Acl -LiteralPath $folder -AclObject $acl
  $check = Get-Acl -LiteralPath $folder
  $permits = @($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq Allow)
  if (!$check.AreAccessRulesProtected -or @($permits | Where-Object {$_.IdentityReference.Value -notin $trusted}).Count -or
      @($permits.IdentityReference.Value | Select-Object -Unique).Count -ne 3) { throw 'Restricted fixture ACL readback failed' }
 `;
 await execute('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{
  env:{...process.env,FROSTVEIL_TEST_FEED_DIRECTORY:resolved},cwd:tempRoot,windowsHide:true,timeout:15000
 });
}

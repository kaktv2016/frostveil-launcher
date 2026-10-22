# Frostveil — Original-source graphics repair

วันที่ 20 ตุลาคม 2026 — Launcher **0.1.12**, สูตรซ่อม **1.0.7**

เผยแพร่ [Launcher 0.1.12](https://github.com/kaktv2016/frostveil-launcher/releases/tag/v0.1.12) พร้อมการตรวจลายเซ็นอัปเดต Ed25519 เดิม ตัวติดตั้งยังไม่มี Windows Authenticode signature ไม่เปลี่ยนกุญแจ ไม่ push source และไม่ deploy/restart เซิร์ฟเวอร์

## พฤติกรรมเมื่อกด Play

1. ตรวจว่า Skyrim/SKSE ปิดและ runtime เป็น 1.6.1170.0 ก่อนเตรียมไฟล์
2. ตรวจแพ็กฐานและสูตรซ่อมที่ยืนยัน SHA-256 จาก pin ใน Launcher
3. ตรวจ 503 เป้าหมาย ถ้าตรงแล้วไม่แตก archive ซ้ำ หากขาด/เสียจะอ่านต้นฉบับจากโฟลเดอร์ที่ตั้งค่าไว้และ Downloads รวมถึงอ่าน BSA ที่ติดตั้งอยู่
4. เตรียมและตรวจ hash ทุกไฟล์ก่อนเริ่มเขียน สำรองไฟล์เดิม ตรวจเกมกำลังทำงานและไฟล์ที่ถูกแก้จากภายนอก แล้วแทนที่ไฟล์ มี journal สำหรับย้อนกลับ/กู้คืนเมื่อขัดจังหวะ
5. ตรวจผลก่อนเปิด SKSE โดยไม่ปิด/ลบม็อด ไม่เปลี่ยน ESP, load order, client JS หรือข้อมูลโลกจากสูตรซ่อมนี้ ขั้นเตรียมแพ็กฐานเดิมยังคงทำงานตามเดิม

เครื่องเจ้าของตั้งค่า `graphics-sources.json` ในข้อมูลแอป Launcher ให้ค้น `C:/Users/basba/OneDrive/Desktop/skyrim-rp/mod-work` แล้ว ไม่มีการคัดลอกไฟล์ลงเกมผู้เล่นด้วยเครื่องมือระหว่างพัฒนา ทดสอบในโฟลเดอร์จำลองเท่านั้น การติดตั้งจริงรอเจ้าของกด Play ผ่าน Launcher

**แก้ไขข้อมูลหลังการทดสอบเจ้าของ:** พบว่า MSIX filesystem virtualization ของ Codex ทำให้ไฟล์ `graphics-sources.json` ที่เครื่องมือเขียนลง AppData ไปอยู่ในพื้นที่แยกของ Codex ตัว Launcher standalone จึงไม่เห็นค่าตั้งต้นนี้ ข้อความก่อนหน้าที่ว่า Launcher ตัวจริงถูกตั้งให้เห็น `mod-work` แล้วจึงไม่ถูกต้อง แก้โดยคัดลอก archive ต้นฉบับที่สูตรใช้งาน 5 ไฟล์ (รวม 1,162,024,720 bytes) จาก `mod-work` ไป `C:/Users/basba/Downloads` ซึ่งเป็น source fallback เดิมของ Launcher ตรวจ SHA-256/size และ realpath ทุกไฟล์แล้ว ต้นฉบับใน `mod-work` คงอยู่ ไม่แก้/ผ่อนการตรวจ containment ไม่แก้เกม และไม่ต้องออกรุ่น Launcher ใหม่ หลักฐานอยู่ที่ `.local/graphics-repair/source-folder-fix.json`

## ตัวเลือกและขอบเขตไฟล์

- **Lux:** คืนโมเดลจริง 310 จุด (232 จากม็อด, 78 อ่านคืนจาก BSA ในเครื่อง) และ texture ที่จำเป็น 109 ไฟล์ รวม 419 เป้าหมาย แทนที่โมเดลแผ่นดำ/เตาไฟที่แพ็กเดิมใช้ผิด ตรวจ FOMOD ให้ตรง Lux 7.0, SMIM, Embers XD และ Community Shaders เดิม ไม่ลง optional plugin เพิ่ม
- **ดอกไม้:** ตรวจไฟล์ที่ใช้งานจริงโดยให้ FFM ทับ library16.52 รวม 80 เป้าหมาย (42 NIF, 37 DDS, 1 INI) พบต้นฉบับที่ต่างจากไฟล์ติดตั้ง 16 asset ไม่ใช้ texture เดาหรือเปลี่ยนชนิดพืชแทน
- **ความหนาแน่น:** FFM ไม่มีเมนูหลายระดับ มี preset เดียว `iMinGrassSize=50`, `iMaxGrassTypesPerTexure=15` จึงเลือกค่าที่ผู้สร้างจัดให้ครบชุด ไม่ตีความเลขยิ่งสูงว่ายิ่งหนาแน่นและไม่เพิ่มค่าทดลองนอกตัวเลือก
- **dependency:** เพิ่ม po3 Tweaks AE1170, PEX/PSC และ INI รวม 4 เป้าหมาย เพื่อ EditorID cache ที่ XPMF/MLO ต้องใช้ INI ระบุครบ 46 ค่าจาก source ให้เปิดเฉพาะ cache และปิด gameplay tweaks อื่น เก็บค่ากลาง voice=1.0, stack timeout=30.0 DLL อยู่ท้ายรายการ apply และทุกไฟล์ถูก stage ก่อนเริ่ม transaction

Lux/FFM จำกัดการอัปโหลดต้นฉบับซ้ำ จึงเผยแพร่ **metadata เท่านั้น** บน R2 ไม่อัปโหลด asset/DLL ของม็อด สูตรซ่อมเก็บ archive/member/hash และข้อมูลอ่าน BSA ไม่มี vanilla game assets ฝังในตัวติดตั้ง สำหรับเครื่องผู้เล่นอื่นยังต้องมี archive ต้นฉบับที่ดาวน์โหลดโดยชอบใน Downloads หรือโฟลเดอร์ source; ยังไม่ใช่ระบบ mirror ม็อดทั้งหมดจาก R2 ให้ผู้เล่นที่ไม่มีต้นฉบับ

## ผลตรวจและทดสอบ

- Typecheck, build และ NSIS ผ่าน
- Regression suite **462/462 ผ่าน** รวมกรณีซ่อมไฟล์ขาด/เสีย, source hash ผิด, เกมกำลังทำงาน, rollback, recovery, concurrent edit, hardlink/path escape, BSA/LZ4 และการป้องกันแพ็กเก่าบังคับคืน mesh ผิดซ้ำ
- ตัวติดตั้งที่แพ็กแล้วผ่าน Electron fixture smoke ไม่เปิด Skyrim จริง
- ทดสอบอ่าน archive จริงและ BSA ในโฟลเดอร์จำลอง **503/503 เป้าหมาย**, 1,182,364,969 bytes hash ตรง กด Play จำลองรอบสองซ่อม **0 ไฟล์** ตรวจเทียบเป้าหมายในเกมจริงก่อน/หลังแล้วไม่เปลี่ยน
- สูตร R2 ดาวน์โหลดแบบไม่ล็อกอินและตรวจ hash ผ่าน ตรวจสิทธิ์ production publisher เดิมและลงนาม manifest จาก GitHub asset ID จริง
- รีวิวแก้แล้ว: recheck ก่อน atomic replace, metadata journal เขียนแบบ durable/atomic, lock ไม่ทิ้ง JSON ว่าง, runtime gate ก่อน dependency writes

## ข้อจำกัดที่ยังเปิดอยู่

- ยังไม่รับรองภาพในเกมจนเจ้าของทดสอบฉากเดิม ทั้งกลางวัน/กลางคืนและคบเพลิง
- Lux มีโมเดลอ้างอิง 3 path ที่ไม่มีในต้นฉบับที่ให้มา แต่ไม่พบ direct placed reference ในชุดปลั๊กอินปัจจุบัน ไม่สร้างโมเดลเดาแทน ยังมี environment maps ที่ต้นฉบับอ้างแต่ไม่ให้มา 6 รายการ
- FFM มี record เก่าที่ไม่ถูก LTEX ใช้งานและอ้างไฟล์ขาด รวมทั้ง normal refs ของ 3 used models ที่ต้นฉบับไม่ให้มา แยกออกจาก diffuse ที่ใช้งานจริง ไม่อ้างว่าแก้ทุก omission ของผู้สร้างแล้ว
- po3 cache-only ผ่าน source review และการตรวจไฟล์ แต่ยังไม่ผ่าน runtime SkyMP gameplay acceptance
- ความขัดแย้ง full-plugin index ระหว่าง client/server จาก audit ก่อนหน้ายังอยู่ งานนี้ไม่เปลี่ยนปลั๊กอินหรือย้ายข้อมูลเซิร์ฟเวอร์ จึง **ยังไม่รับรอง online compatibility ทั้งชุด**

## การย้อนกลับและหลักฐาน

Launcher เก็บ preimage และ complete/rolled-back journal ใน `%LOCALAPPDATA%/SkyrimRPLauncher/graphics-source-repair/<transaction-id>/` ไม่ลบ archive ต้นฉบับ หากเกมเริ่มระหว่างซ่อมจะหยุดและเก็บสถานะ recovery ไว้ให้รอบถัดไป ไม่ย้อนกลับขณะเกมกำลังทำงาน

- Installer SHA-256: `35666ff4429a938d681ecf4f4d50e2a6b86b0a58e3b836dd31806187196cc720`
- Corresponding source ZIP SHA-256: `97d50abd485ca3763d72324c865540fe7230fb5e234b2feedfcf7e1d88ffe058`
- Metadata recipe SHA-256: `f6aca9c20159ff2fa31ef53b1e632fc8818a679b2e05d8e27572c0baea9b398d`
- รายละเอียด source selection/QA: `../mod-dist/graphics-repair-107/{lux,flora}/`
- ผล regression, fixture, packaging, publication และ anonymous verification: `.local/graphics-repair/`

ทดสอบในเกมชุดเดียว: ปิดเกม → อัปเดต Launcher เป็น0.1.12 → Play รอซ่อมครั้งแรก → ดูดอกไม้/แผ่นดำฉากเดิมพร้อมคบเพลิง → ออกเกมและ Play อีกครั้ง ตรวจว่าไม่ซ่อมซ้ำโดยไม่มีไฟล์เปลี่ยน

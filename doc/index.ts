import main from "./main";
import fs from "fs";

const spec = main()
const openAPIObject = JSON.stringify(spec, null, 2);
fs.writeFileSync("./out/openapi.json", openAPIObject)

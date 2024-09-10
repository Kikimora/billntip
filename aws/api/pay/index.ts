import {Lambdas} from "@aws/lambdas";
import Paths from "@src/billntip/pay-paths";
import gw from "../gateway";
import {newApiGwIntegration} from "@aws/util";

const lambda = gw.newLambda(Lambdas['billntip/pay.handler'])
    .args({
        timeout: 10
    })
    .build()

export default newApiGwIntegration(gw, lambda)
    .addRoutes(Paths)
    .done()
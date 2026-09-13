import type { NextApiRequest, NextApiResponse } from "next";
import { handleApiRequest } from "../../api/_handler";

export const config = {
  api: { bodyParser: false },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleApiRequest(req, res);
}

/**
 * The module Remotion's bundler is pointed at. `registerRoot` is its required entry contract.
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);

import logo from "../../../assets/logo.jpg";

export { logo };

export function BrandMark() {
  return <img className="brand-mark" src={logo} alt="" width={32} height={32} />;
}

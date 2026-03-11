const webpack = require("webpack");
require("dotenv").config();

module.exports = {
  plugins: [
    new webpack.DefinePlugin({
      __DROPBOX_APP_KEY__: JSON.stringify(process.env.DROPBOX_APP_KEY),
    }),
  ],
};
